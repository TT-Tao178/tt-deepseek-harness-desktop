use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Probes whether a kernel process is healthy on the given port.
///
/// Connects to `127.0.0.1:port`, sends a minimal HTTP GET request and
/// treats the process as healthy when the response status line contains
/// `200` or `302`. Any error (connect, write, read, non-matching status)
/// results in `false`.
pub fn is_healthy(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };

    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    // Bound the read/write as well so a server that accepts but never
    // answers cannot hang the probe indefinitely.
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }

    // Read the response status line (up to the first CRLF / EOF / cap).
    let mut status_line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                status_line.push(byte[0]);
                if status_line.ends_with(b"\r\n") || status_line.len() >= 2048 {
                    break;
                }
            }
            Err(_) => return false,
        }
    }

    let line = String::from_utf8_lossy(&status_line);
    line.contains("200") || line.contains("302")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn healthy_when_server_answers_200() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("listener address").port();

        let server = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                break;
            }
        });

        assert!(is_healthy(port, Duration::from_secs(2)));
        let _ = server.join();
    }

    #[test]
    fn unhealthy_when_port_is_closed() {
        // Reserve a port and immediately release it, so nothing is
        // listening there.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
            listener.local_addr().expect("listener address").port()
        };

        assert!(!is_healthy(port, Duration::from_secs(1)));
    }
}

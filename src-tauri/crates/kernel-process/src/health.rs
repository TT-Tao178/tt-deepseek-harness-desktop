use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Probes whether a kernel process is healthy on the given port.
///
/// Connects to `127.0.0.1:port`, sends a minimal HTTP GET request and
/// treats the kernel as healthy as soon as it answers with **any** valid
/// HTTP response.
///
/// 判据刻意放宽成「任何状态码」：新版内核对不带 token 的请求返回
/// **401**（根路径变为 `/?token=...` 鉴权，旧版直接 200）。只认 200/302
/// 会把「已成功更新的新内核」误判为不健康，进而触发自动回滚——更新永远
/// 装不上（P26）。这里要回答的问题是「内核起来了吗」，不是「这个请求被
/// 授权了吗」，所以只看是否拿到了合法的状态行。
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

    // 必须是合法的 HTTP 状态行（`HTTP/1.1 200 OK` / `HTTP/1.0 401 …`）。
    // 端口上开着别的服务（无状态行）仍判为不健康。
    String::from_utf8_lossy(&status_line).starts_with("HTTP/")
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

    /// P26 回归：新版内核根路径要求 token，未带 token 时返回 401。
    /// 401 说明「内核已经在应答」，必须判为健康，否则更新成功也会被自动回滚。
    #[test]
    fn healthy_when_kernel_answers_401_unauthorized() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("listener address").port();

        let server = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
                );
                break;
            }
        });

        assert!(
            is_healthy(port, Duration::from_secs(2)),
            "401 是合法 HTTP 应答，内核已就绪"
        );
        let _ = server.join();
    }

    /// 端口上开着非 HTTP 服务时仍须判为不健康（不能只看「连得上」）。
    #[test]
    fn unhealthy_when_response_is_not_http() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("listener address").port();

        let server = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"220 smtp service ready\r\n");
                break;
            }
        });

        assert!(!is_healthy(port, Duration::from_secs(2)));
        let _ = server.join();
    }
}

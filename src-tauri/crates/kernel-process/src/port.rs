use std::io;
use std::net::TcpListener;

/// Reserves a free TCP port on the loopback interface.
///
/// Binds a listener to `127.0.0.1:0` (letting the OS pick an ephemeral
/// port), reads the assigned port and drops the listener so the port is
/// free again for the caller to bind.
pub fn reserve_free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_free_port_is_nonzero_and_rebindable() {
        let first = reserve_free_port().expect("first reservation");
        let second = reserve_free_port().expect("second reservation");

        assert_ne!(first, 0, "reserved port must not be 0");
        assert_ne!(second, 0, "reserved port must not be 0");

        // Both returned ports must be immediately rebindable (the listener
        // used to reserve them was dropped).
        for port in [first, second] {
            let listener = TcpListener::bind(("127.0.0.1", port));
            assert!(listener.is_ok(), "port {port} should be rebindable");
        }
    }
}

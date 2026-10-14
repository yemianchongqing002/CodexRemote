pub(crate) fn tailnet_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            let b = v.octets();
            b[0] == 100 && (64..=127).contains(&b[1])
        }
        std::net::IpAddr::V6(v) => v.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

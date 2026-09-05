use std::io::Read;

pub const OUTPUT_LIMIT: usize = 64 * 1024;

// Keep one extra byte as a truncation marker while draining the entire pipe.
pub fn read_bounded(mut pipe: impl Read) -> Vec<u8> {
    let mut result = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(count) = pipe.read(&mut chunk) {
        if count == 0 { break; }
        let retained = count.min((OUTPUT_LIMIT + 1).saturating_sub(result.len()));
        result.extend_from_slice(&chunk[..retained]);
    }
    result
}

pub fn output_text(bytes: Vec<u8>) -> String {
    let truncated = bytes.len() > OUTPUT_LIMIT;
    let mut text = String::from_utf8_lossy(&bytes[..bytes.len().min(OUTPUT_LIMIT)]).into_owned();
    if truncated { text.push_str("\n[output truncated]"); }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_output_without_retaining_unbounded_bytes() {
        let data = vec![b'x'; OUTPUT_LIMIT * 8];
        let mut reader = std::io::Cursor::new(&data);
        let output = read_bounded(&mut reader);
        assert_eq!(reader.position() as usize, data.len());
        assert_eq!(output.len(), OUTPUT_LIMIT + 1);
        assert!(output_text(output).ends_with("[output truncated]"));
    }

    #[test]
    fn preserves_small_output_and_handles_split_utf8() {
        assert_eq!(output_text(read_bounded(&b"hello"[..])), "hello");
        let bytes = "🌿".repeat(OUTPUT_LIMIT).into_bytes();
        assert!(output_text(read_bounded(bytes.as_slice())).ends_with("[output truncated]"));
    }
}

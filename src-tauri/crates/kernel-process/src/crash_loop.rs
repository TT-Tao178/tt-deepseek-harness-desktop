/// Exponential backoff for restarting a crashed kernel process.
#[derive(Debug, Clone, Copy, Default)]
pub struct Backoff {
    /// Number of attempts already made.
    attempts: u32,
}

impl Backoff {
    /// Creates a fresh backoff with zero attempts.
    pub fn new() -> Self {
        Backoff { attempts: 0 }
    }

    /// Returns the delay in milliseconds before the next restart attempt,
    /// or `None` once the backoff is exhausted (after the third attempt).
    ///
    /// Sequence: 1st attempt `1000`, 2nd `4000`, 3rd `16000`, then `None`.
    pub fn next_delay_ms(&mut self) -> Option<u64> {
        let delay = match self.attempts {
            0 => Some(1000),
            1 => Some(4000),
            2 => Some(16000),
            _ => None,
        };
        self.attempts = self.attempts.saturating_add(1);
        delay
    }

    /// Resets the attempt counter to zero.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }

    /// Number of attempts made so far.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence_then_exhaustion() {
        let mut backoff = Backoff::new();
        assert_eq!(backoff.attempts(), 0);
        assert_eq!(backoff.next_delay_ms(), Some(1000));
        assert_eq!(backoff.next_delay_ms(), Some(4000));
        assert_eq!(backoff.next_delay_ms(), Some(16000));
        assert_eq!(backoff.next_delay_ms(), None);
        assert_eq!(backoff.attempts(), 4, "attempts counts calls made");
        assert_eq!(backoff.next_delay_ms(), None, "stays exhausted");
        assert_eq!(backoff.attempts(), 5);
    }

    #[test]
    fn reset_restarts_sequence() {
        let mut backoff = Backoff::new();
        let _ = backoff.next_delay_ms();
        let _ = backoff.next_delay_ms();
        let _ = backoff.next_delay_ms();
        assert_eq!(backoff.next_delay_ms(), None);

        backoff.reset();
        assert_eq!(backoff.attempts(), 0);
        assert_eq!(backoff.next_delay_ms(), Some(1000));
    }
}

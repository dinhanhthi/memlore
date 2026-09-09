//! Compose a flat prompt string from a `[Message]` slice for CLI providers.
//!
//! Claude has a dedicated `--system-prompt` flag, so we split system text
//! from the rest. Codex has no equivalent, so its provider folds the
//! system block back into the user body via [`fold_system_into_body`].

use crate::ai::provider::{Message, MessageRole};

/// Output of [`build_prompt`]: the system block (already concatenated,
/// without any prefix label) and the user/assistant transcript ending in
/// an open `Assistant:` turn for the model to complete.
pub struct PromptParts {
    pub system: String,
    pub body: String,
}

/// Build a flat prompt from the conversation. All `System` messages are
/// concatenated (in order, separated by blank lines) into `system`. The
/// remaining turns are formatted as a `User: ... / Assistant: ...`
/// transcript, with a trailing `Assistant:` that the model will complete.
///
/// The transcript closes with a single newline so the CLI's stdin reads
/// cleanly; the final `Assistant:` line is intentionally left without a
/// trailing space — token-stream models prepend their own whitespace.
pub fn build_prompt(messages: &[Message]) -> PromptParts {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut transcript_parts: Vec<String> = Vec::new();

    for msg in messages {
        match msg.role {
            MessageRole::System => {
                let t = msg.content.trim();
                if !t.is_empty() {
                    system_parts.push(t);
                }
            }
            MessageRole::User => {
                transcript_parts.push(format!("User: {}", msg.content.trim()));
            }
            MessageRole::Assistant => {
                transcript_parts.push(format!("Assistant: {}", msg.content.trim()));
            }
        }
    }

    // Always end with an open Assistant turn so the model completes it.
    // If the last transcript line is already `Assistant: ...`, we still
    // append a fresh open turn — that matches the chat-completions
    // convention where the assistant's prior reply is closed and a new
    // generation begins.
    transcript_parts.push("Assistant:".to_string());

    PromptParts {
        system: system_parts.join("\n\n"),
        body: transcript_parts.join("\n\n"),
    }
}

/// For providers that don't expose a separate system-prompt flag (Codex),
/// fold the system block into the user body. The combined string is what
/// the provider writes to the CLI's stdin / prompt arg.
pub fn fold_system_into_body(parts: &PromptParts) -> String {
    if parts.system.is_empty() {
        parts.body.clone()
    } else {
        format!("System instructions:\n{}\n\n{}", parts.system, parts.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: MessageRole, content: &str) -> Message {
        Message {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn build_prompt_single_user_has_empty_system_and_open_assistant() {
        let parts = build_prompt(&[msg(MessageRole::User, "hello")]);
        assert!(parts.system.is_empty());
        assert_eq!(parts.body, "User: hello\n\nAssistant:");
    }

    #[test]
    fn build_prompt_system_and_user_separates_system_block() {
        let parts = build_prompt(&[
            msg(MessageRole::System, "be brief"),
            msg(MessageRole::User, "hi"),
        ]);
        assert_eq!(parts.system, "be brief");
        assert_eq!(parts.body, "User: hi\n\nAssistant:");
    }

    #[test]
    fn build_prompt_multi_turn_preserves_order() {
        let parts = build_prompt(&[
            msg(MessageRole::User, "1+1"),
            msg(MessageRole::Assistant, "2"),
            msg(MessageRole::User, "and 2+2"),
        ]);
        assert!(parts.system.is_empty());
        assert_eq!(
            parts.body,
            "User: 1+1\n\nAssistant: 2\n\nUser: and 2+2\n\nAssistant:"
        );
    }

    #[test]
    fn build_prompt_multiple_system_messages_concatenate() {
        let parts = build_prompt(&[
            msg(MessageRole::System, "rule one"),
            msg(MessageRole::System, "rule two"),
            msg(MessageRole::User, "go"),
        ]);
        assert_eq!(parts.system, "rule one\n\nrule two");
        assert_eq!(parts.body, "User: go\n\nAssistant:");
    }

    #[test]
    fn build_prompt_trims_whitespace_in_contents() {
        let parts = build_prompt(&[
            msg(MessageRole::System, "  s  "),
            msg(MessageRole::User, "\n hello \n"),
        ]);
        assert_eq!(parts.system, "s");
        assert_eq!(parts.body, "User: hello\n\nAssistant:");
    }

    #[test]
    fn build_prompt_skips_empty_system_messages() {
        let parts = build_prompt(&[
            msg(MessageRole::System, "   "),
            msg(MessageRole::User, "hi"),
        ]);
        assert!(parts.system.is_empty());
    }

    #[test]
    fn fold_system_into_body_no_system_passthrough() {
        let parts = PromptParts {
            system: String::new(),
            body: "User: hi\n\nAssistant:".to_string(),
        };
        assert_eq!(fold_system_into_body(&parts), "User: hi\n\nAssistant:");
    }

    #[test]
    fn fold_system_into_body_prefixes_system_block() {
        let parts = PromptParts {
            system: "be brief".to_string(),
            body: "User: hi\n\nAssistant:".to_string(),
        };
        let combined = fold_system_into_body(&parts);
        assert_eq!(
            combined,
            "System instructions:\nbe brief\n\nUser: hi\n\nAssistant:"
        );
    }
}

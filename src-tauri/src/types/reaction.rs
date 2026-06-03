//! Reaction DTOs surfaced to the UI (`types` layer, ADR-0003).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! `Reaction` struct and `ReactionIcon`/`Reactions` enums into these DTOs.

use serde::{Deserialize, Serialize};

/// A reaction event from the realtime listener — someone added a reaction to a
/// message. Carries only display data; the emoji character is pre-resolved so
/// the UI renders it directly without knowing Zalo's internal icon codes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReactionEvent {
    /// Thread the reacted message belongs to.
    pub thread_id: String,
    /// The message that received the reaction.
    pub msg_id: String,
    /// Who reacted.
    pub uid_from: String,
    /// Display name of the reactor (may be None for self/group events).
    pub d_name: Option<String>,
    /// The emoji character to render (e.g. "❤️", "👍", "😆").
    pub icon: String,
    /// True when the reaction came from this account.
    pub is_self: bool,
    /// True when the thread is a group.
    pub is_group: bool,
}

/// Standard Zalo reaction icons the UI can send. The `zalo` layer maps these to
/// `zca-rust`'s `Reactions` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReactionIcon {
    Heart,
    Like,
    Haha,
    Wow,
    Cry,
    Angry,
    Kiss,
    TearsOfJoy,
    Shit,
    Rose,
    BrokenHeart,
    Dislike,
    Love,
    Confused,
    Wink,
    Fade,
    Sun,
    Birthday,
    Bomb,
    Ok,
    Peace,
    Thanks,
    Punch,
}

impl ReactionIcon {
    /// The emoji character the UI renders for this icon.
    pub fn emoji(self) -> &'static str {
        match self {
            Self::Heart => "❤️",
            Self::Like => "👍",
            Self::Haha => "😆",
            Self::Wow => "😮",
            Self::Cry => "😢",
            Self::Angry => "😠",
            Self::Kiss => "😘",
            Self::TearsOfJoy => "😂",
            Self::Shit => "💩",
            Self::Rose => "🌹",
            Self::BrokenHeart => "💔",
            Self::Dislike => "👎",
            Self::Love => "😍",
            Self::Confused => "😕",
            Self::Wink => "😉",
            Self::Fade => "😶",
            Self::Sun => "☀️",
            Self::Birthday => "🎂",
            Self::Bomb => "💣",
            Self::Ok => "👌",
            Self::Peace => "✌️",
            Self::Thanks => "🙏",
            Self::Punch => "👊",
        }
    }
}

/// Resolve a Zalo `rIcon` string (e.g. "/-heart", "/-strong") to our
/// [`ReactionIcon`]. Returns `None` for unknown icon strings.
pub fn reaction_icon_from_zalo(s: &str) -> Option<ReactionIcon> {
    match s {
        "/-heart" => Some(ReactionIcon::Heart),
        "/-strong" => Some(ReactionIcon::Like),
        ":>" => Some(ReactionIcon::Haha),
        ":o" => Some(ReactionIcon::Wow),
        ":-(" => Some(ReactionIcon::Cry),
        ":-h" => Some(ReactionIcon::Angry),
        ":-*" => Some(ReactionIcon::Kiss),
        ":'\\)" => Some(ReactionIcon::TearsOfJoy),
        "/-shit" => Some(ReactionIcon::Shit),
        "/-rose" => Some(ReactionIcon::Rose),
        "/-break" => Some(ReactionIcon::BrokenHeart),
        "/-weak" => Some(ReactionIcon::Dislike),
        ";xx" => Some(ReactionIcon::Love),
        ";-/" => Some(ReactionIcon::Confused),
        ";-\\)" => Some(ReactionIcon::Wink),
        "/-fade" => Some(ReactionIcon::Fade),
        "/-li" => Some(ReactionIcon::Sun),
        "/-bd" => Some(ReactionIcon::Birthday),
        "/-bome" => Some(ReactionIcon::Bomb),
        "/-ok" => Some(ReactionIcon::Ok),
        "/-v" => Some(ReactionIcon::Peace),
        "/-thanks" => Some(ReactionIcon::Thanks),
        "/-punch" => Some(ReactionIcon::Punch),
        _ => None,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_zalo_icons() {
        assert_eq!(reaction_icon_from_zalo("/-heart"), Some(ReactionIcon::Heart));
        assert_eq!(reaction_icon_from_zalo("/-strong"), Some(ReactionIcon::Like));
        assert_eq!(reaction_icon_from_zalo(":>"), Some(ReactionIcon::Haha));
    }

    #[test]
    fn unknown_icon_is_none() {
        assert_eq!(reaction_icon_from_zalo("unknown"), None);
    }

    #[test]
    fn every_icon_has_emoji() {
        // Every variant must map to a non-empty emoji string.
        let icons = [
            ReactionIcon::Heart, ReactionIcon::Like, ReactionIcon::Haha,
            ReactionIcon::Wow, ReactionIcon::Cry, ReactionIcon::Angry,
            ReactionIcon::Kiss, ReactionIcon::TearsOfJoy, ReactionIcon::Shit,
            ReactionIcon::Rose, ReactionIcon::BrokenHeart, ReactionIcon::Dislike,
            ReactionIcon::Love, ReactionIcon::Confused, ReactionIcon::Wink,
            ReactionIcon::Fade, ReactionIcon::Sun, ReactionIcon::Birthday,
            ReactionIcon::Bomb, ReactionIcon::Ok, ReactionIcon::Peace,
            ReactionIcon::Thanks, ReactionIcon::Punch,
        ];
        for icon in icons {
            assert!(!icon.emoji().is_empty(), "{icon:?} must have a non-empty emoji");
        }
    }
}

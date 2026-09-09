//! Optional video compression applied before media files land in the media
//! directory. Reduces the on-disk + sync footprint of clips coming in from the
//! Photo Library or file picker by transcoding them to H.264 + AAC `.mp4` at a
//! downscaled resolution.
//!
//! Unlike image compression (which runs in-process via the `image` crate), the
//! actual transcode is delegated to macOS AVFoundation (`AVAssetExportSession`)
//! through the swift-rs bridge — VideoToolbox provides the H.264 encoder, so no
//! codec is bundled and there is no GPL / patent-royalty exposure. This module
//! is the pure, platform-independent policy layer: it maps the user's Settings
//! choice to an AVFoundation resolution preset name. The actual FFI call and
//! the "only keep it if it's smaller" guard live in the media command.

/// Compression preset chosen via Settings. The frontend writes one of these
/// strings to the `video_compression_mode` setting; `from_settings` does the
/// conversion. Default `Standard` matches the most common phone-clip case.
///
/// Mirrors `image_compression::CompressionMode`, but video "quality" is baked
/// into the AVFoundation resolution preset — there is no separate quality knob,
/// so `Custom` carries only a `max_edge` that selects the nearest preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCompressionMode {
    /// Pass every video through unchanged. Original bytes go to disk.
    Off,
    /// Downscale to 960 × 540 (qHD). Sensible default for journal clips.
    Standard,
    /// Downscale to 640 × 480. Heavier squeeze for sync-bandwidth constrained
    /// users.
    Aggressive,
    /// User-provided max edge from Settings, mapped to the nearest preset.
    Custom { max_edge: u32 },
}

impl VideoCompressionMode {
    pub fn from_settings(mode: &str, edge: Option<u32>) -> Self {
        match mode.trim().to_lowercase().as_str() {
            "off" => Self::Off,
            "aggressive" => Self::Aggressive,
            "custom" => Self::Custom {
                max_edge: edge.unwrap_or(960).clamp(240, 3840),
            },
            // Default: "standard" or any unknown / empty value
            _ => Self::Standard,
        }
    }

    /// AVFoundation `AVAssetExportPreset*` name the export session should use,
    /// or `None` when no transcode should run (`Off`). These presets all encode
    /// H.264 video + AAC audio and preserve aspect ratio (the frame is fit
    /// inside the named box, never upscaled by the encoder).
    ///
    /// `Custom` picks the smallest preset whose long edge is >= the requested
    /// `max_edge`, so a larger request keeps more detail while a request below
    /// the floor still lands on the smallest preset.
    pub fn preset_name(&self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Standard => Some("AVAssetExportPreset960x540"),
            Self::Aggressive => Some("AVAssetExportPreset640x480"),
            Self::Custom { max_edge } => Some(preset_for_max_edge(*max_edge)),
        }
    }
}

/// Preset long edges, ascending. Kept in sync with the returned names below.
const PRESET_LADDER: [(u32, &str); 4] = [
    (480, "AVAssetExportPreset640x480"),
    (540, "AVAssetExportPreset960x540"),
    (720, "AVAssetExportPreset1280x720"),
    (1080, "AVAssetExportPreset1920x1080"),
];

/// Smallest preset whose long edge is >= `max_edge`; the largest preset when
/// `max_edge` exceeds every rung.
fn preset_for_max_edge(max_edge: u32) -> &'static str {
    for (edge, name) in PRESET_LADDER {
        if max_edge <= edge {
            return name;
        }
    }
    PRESET_LADDER[PRESET_LADDER.len() - 1].1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_settings_parses_known_modes() {
        assert_eq!(
            VideoCompressionMode::from_settings("off", None),
            VideoCompressionMode::Off
        );
        assert_eq!(
            VideoCompressionMode::from_settings("standard", None),
            VideoCompressionMode::Standard
        );
        assert_eq!(
            VideoCompressionMode::from_settings("aggressive", None),
            VideoCompressionMode::Aggressive
        );
        assert_eq!(
            VideoCompressionMode::from_settings("custom", Some(720)),
            VideoCompressionMode::Custom { max_edge: 720 }
        );
    }

    #[test]
    fn from_settings_is_case_and_whitespace_insensitive() {
        assert_eq!(
            VideoCompressionMode::from_settings("  OFF ", None),
            VideoCompressionMode::Off
        );
        assert_eq!(
            VideoCompressionMode::from_settings(" Aggressive", None),
            VideoCompressionMode::Aggressive
        );
    }

    #[test]
    fn from_settings_unknown_and_empty_default_to_standard() {
        assert_eq!(
            VideoCompressionMode::from_settings("", None),
            VideoCompressionMode::Standard
        );
        assert_eq!(
            VideoCompressionMode::from_settings("garbage", None),
            VideoCompressionMode::Standard
        );
    }

    #[test]
    fn custom_clamps_max_edge_and_missing_edge_defaults() {
        assert_eq!(
            VideoCompressionMode::from_settings("custom", None),
            VideoCompressionMode::Custom { max_edge: 960 }
        );
        assert_eq!(
            VideoCompressionMode::from_settings("custom", Some(10)),
            VideoCompressionMode::Custom { max_edge: 240 }
        );
        assert_eq!(
            VideoCompressionMode::from_settings("custom", Some(99999)),
            VideoCompressionMode::Custom { max_edge: 3840 }
        );
    }

    #[test]
    fn preset_name_off_is_none() {
        assert_eq!(VideoCompressionMode::Off.preset_name(), None);
    }

    #[test]
    fn preset_name_standard_and_aggressive() {
        assert_eq!(
            VideoCompressionMode::Standard.preset_name(),
            Some("AVAssetExportPreset960x540")
        );
        assert_eq!(
            VideoCompressionMode::Aggressive.preset_name(),
            Some("AVAssetExportPreset640x480")
        );
    }

    #[test]
    fn custom_preset_selects_nearest_upward_rung() {
        // Below the floor → smallest preset.
        assert_eq!(
            VideoCompressionMode::Custom { max_edge: 300 }.preset_name(),
            Some("AVAssetExportPreset640x480")
        );
        // Exact rung.
        assert_eq!(
            VideoCompressionMode::Custom { max_edge: 720 }.preset_name(),
            Some("AVAssetExportPreset1280x720")
        );
        // Between rungs rounds up.
        assert_eq!(
            VideoCompressionMode::Custom { max_edge: 900 }.preset_name(),
            Some("AVAssetExportPreset1920x1080")
        );
        // Above the ceiling → largest preset.
        assert_eq!(
            VideoCompressionMode::Custom { max_edge: 3840 }.preset_name(),
            Some("AVAssetExportPreset1920x1080")
        );
    }
}

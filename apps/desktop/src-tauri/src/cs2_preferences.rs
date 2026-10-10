use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    VeryHigh,
    High,
    Medium,
    Preserve,
}
impl Quality {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "very-high" => Ok(Self::VeryHigh),
            "high" => Ok(Self::High),
            "medium" => Ok(Self::Medium),
            "preserve" => Ok(Self::Preserve),
            _ => Err("CS2 画质选项无效。".into()),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::VeryHigh => "very-high",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Preserve => "preserve",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub quality: Quality,
    pub frame_rate_limit: u16,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            quality: Quality::VeryHigh,
            frame_rate_limit: 60,
        }
    }
}
impl Preferences {
    pub fn new(quality: &str, frame_rate_limit: u16) -> Result<Self, String> {
        if ![0, 30, 60].contains(&frame_rate_limit) {
            return Err("CS2 帧率仅支持 60、30 或不限帧。".into());
        }
        Ok(Self {
            quality: Quality::parse(quality)?,
            frame_rate_limit,
        })
    }
    pub fn from_json(value: &Value) -> Result<Self, String> {
        if let Some(quality) = value["qualityPreset"].as_str() {
            let limit = value["frameRateLimit"]
                .as_u64()
                .and_then(|v| u16::try_from(v).ok())
                .ok_or("CS2 帧率设置无法读取。")?;
            Self::new(quality, limit)
        } else if let Some(preserve) = value["preserveQuality"].as_bool() {
            Ok(Self {
                quality: if preserve {
                    Quality::Preserve
                } else {
                    Quality::VeryHigh
                },
                ..Self::default()
            })
        } else {
            Err("CS2 启动设置无法读取。".into())
        }
    }
    pub fn json(self) -> Value {
        json!({"qualityPreset": self.quality.name(), "frameRateLimit": self.frame_rate_limit})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_quality_choices_migrate_without_enabling_unlimited_frames() {
        for preserve in [false, true] {
            let preferences = Preferences::from_json(&json!({"preserveQuality":preserve})).unwrap();
            assert_eq!(preferences.frame_rate_limit, 60);
            assert_eq!(preferences.quality == Quality::Preserve, preserve);
            assert_eq!(
                Preferences::from_json(&preferences.json()).unwrap(),
                preferences
            );
        }
        for invalid in [
            json!({}),
            json!({"qualityPreset":"high", "frameRateLimit":120}),
            json!({"qualityPreset":"invalid", "frameRateLimit":60}),
        ] {
            assert!(Preferences::from_json(&invalid).is_err());
        }
    }
}

use serde_json::{json, Value};

use crate::desktop_lifecycle::FrameRateLimit;
pub use crate::desktop_lifecycle::QualityPreset as Quality;

impl Quality {
    pub fn parse(value: &str) -> Result<Self, String> {
        let input = serde::de::value::StrDeserializer::<serde::de::value::Error>::new(value);
        serde::Deserialize::deserialize(input).map_err(|_| "CS2 画质选项无效。".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub quality: Quality,
    pub frame_rate_limit: u16,
    pub prefer_mulnx: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            quality: Quality::Medium,
            frame_rate_limit: 60,
            prefer_mulnx: false,
        }
    }
}
impl Preferences {
    pub fn new(quality: &str, frame_rate_limit: u16) -> Result<Self, String> {
        if FrameRateLimit::try_from(frame_rate_limit).is_err() {
            return Err("CS2 帧率仅支持 60、30 或不限帧。".into());
        }
        Ok(Self {
            quality: Quality::parse(quality)?,
            frame_rate_limit,
            prefer_mulnx: false,
        })
    }
    pub fn from_json(value: &Value) -> Result<Self, String> {
        if let Some(quality) = value["qualityPreset"].as_str() {
            let limit = value["frameRateLimit"]
                .as_u64()
                .and_then(|v| u16::try_from(v).ok())
                .ok_or("CS2 帧率设置无法读取。")?;
            let mut preferences = Self::new(quality, limit)?;
            let saved = match value.get("preferMulnx") {
                None => None,
                Some(value) => Some(value.as_bool().ok_or("CS2 启动方式无法读取。")?),
            };
            preferences.prefer_mulnx = match value.get("launchPreferenceVersion") {
                None => saved.unwrap_or(false),
                Some(version) if version == 2 => saved.ok_or("CS2 启动方式无法读取。")?,
                Some(_) => return Err("CS2 启动方式版本无法读取。".into()),
            };
            Ok(preferences)
        } else if let Some(preserve) = value["preserveQuality"].as_bool() {
            Ok(Self {
                quality: if preserve {
                    Quality::Preserve
                } else {
                    Quality::VeryHigh
                },
                prefer_mulnx: false,
                ..Self::default()
            })
        } else {
            Err("CS2 启动设置无法读取。".into())
        }
    }
    pub fn json(self) -> Value {
        json!({"qualityPreset": self.quality.name(), "frameRateLimit": self.frame_rate_limit, "preferMulnx": self.prefer_mulnx, "launchPreferenceVersion": 2})
    }
}

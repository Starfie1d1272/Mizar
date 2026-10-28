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
    pub prefer_mulnx: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            quality: Quality::VeryHigh,
            frame_rate_limit: 60,
            prefer_mulnx: true,
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
                None => true,
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
                prefer_mulnx: true,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_choice_survives_restart_and_legacy_migrates_to_mulnx() {
        assert_eq!(
            Preferences::default().json(),
            json!({"qualityPreset": "very-high", "frameRateLimit": 60, "preferMulnx": true, "launchPreferenceVersion": 2})
        );
        for quality in ["very-high", "high", "medium", "preserve"] {
            for limit in [0, 30, 60] {
                assert!(!Preferences::new(quality, limit).unwrap().prefer_mulnx);
            }
        }
        let legacy = json!({"qualityPreset":"high","frameRateLimit":30});
        let mut choice = Preferences::from_json(&legacy).unwrap();
        assert!(choice.prefer_mulnx);
        for prefer_mulnx in [true, false] {
            choice.prefer_mulnx = prefer_mulnx;
            assert_eq!(Preferences::from_json(&choice.json()).unwrap(), choice);
        }
        for preserve in [true, false] {
            let old = Preferences::from_json(&json!({"preserveQuality": preserve})).unwrap();
            assert!(old.prefer_mulnx);
            assert_eq!(old.quality == Quality::Preserve, preserve);
        }
        assert!(Preferences::from_json(&json!({"qualityPreset":"high","frameRateLimit":30,"preferMulnx":false})).unwrap().prefer_mulnx);
        let mut invalid = legacy;
        invalid["preferMulnx"] = json!("true");
        assert!(Preferences::from_json(&invalid).is_err());
    }
}

//! Local lifecycle HTTP contract, shared with Companion's request validation.
use serde_json::{Map, Value};
use std::sync::OnceLock;

fn definition() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../companion/src/match-context/lifecycle-contract.json"
        ))
        .expect("valid lifecycle contract")
    })
}

fn fields(kind: &str, value: &Value) -> Result<Value, String> {
    let input = value.as_object().ok_or("生命周期响应无效。")?;
    let shape = definition()[kind].as_object().ok_or("生命周期契约无效。")?;
    let mut result = Map::new();
    for (name, rule) in shape {
        if rule["type"] == "boolean" {
            let value = input
                .get(name)
                .and_then(Value::as_bool)
                .ok_or("生命周期响应无效。")?;
            result.insert(name.clone(), Value::Bool(value));
            continue;
        }
        let text = input
            .get(name)
            .and_then(Value::as_str)
            .ok_or("生命周期响应无效。")?;
        let length = text.encode_utf16().count();
        if rule["min"].as_u64().is_some_and(|v| length < v as usize)
            || rule["max"].as_u64().is_some_and(|v| length > v as usize)
        {
            return Err("生命周期响应无效。".into());
        }
        if let Some(format) = rule["format"].as_str() {
            let pattern = definition()["patterns"][format]
                .as_str()
                .ok_or("生命周期契约无效。")?;
            let regex = regex::Regex::new(pattern).map_err(|_| "生命周期契约无效。")?;
            if !regex.is_match(text) {
                return Err("生命周期响应无效。".into());
            }
        }
        if let Some(values) = rule["values"].as_array() {
            if !values.iter().any(|v| v.as_str() == Some(text)) {
                return Err("生命周期响应无效。".into());
            }
        }
        result.insert(name.clone(), Value::String(text.to_owned()));
    }
    Ok(Value::Object(result))
}

pub struct Qualification(Value);
impl Qualification {
    pub fn from_response(response: &Value) -> Result<Option<Self>, String> {
        match response.get("qualification") {
            Some(Value::Null) => Ok(None),
            Some(value) => fields("qualification", value)
                .map(|value| Some(Self(value)))
                .map_err(|_| "本场回收资格响应无效。请重试；再次失败时查看诊断。".into()),
            None => Err("本场回收资格响应无效。请重试；再次失败时查看诊断。".into()),
        }
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
}

pub struct ProductionView {
    pub mode: String,
    pub revision: String,
}
pub fn production_view(value: &Value) -> Result<ProductionView, String> {
    let value = fields("productionView", value).map_err(|_| "制作状态无效。")?;
    Ok(ProductionView {
        mode: value["mode"].as_str().expect("validated mode").into(),
        revision: value["revision"]
            .as_str()
            .expect("validated revision")
            .into(),
    })
}

pub fn cancellation_entered(value: &Value) -> Result<bool, String> {
    let value =
        fields("cancellationResponse", value).map_err(|_| "取消结果未确认，请核对制作状态。")?;
    Ok(value["entered"].as_bool().expect("validated cancellation"))
}

pub fn is_retryable(status: u16, value: &Value, kind: &str) -> bool {
    let expected = &definition()["errors"][kind];
    expected["status"].as_u64() == Some(u64::from(status))
        && value["status"].as_u64() == Some(u64::from(status))
        && expected["retryable"] == true
        && value["retryable"] == true
        && value["error"]
            .as_str()
            .is_some_and(|code| expected["error"].as_str() == Some(code))
}

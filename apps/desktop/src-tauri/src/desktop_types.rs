use crate::ipc_contract::desktop_ipc;
pub(crate) type JsonObject = std::collections::BTreeMap<String, serde_json::Value>;
pub(crate) type JsonValue = serde_json::Value;

macro_rules! native_type {
    (Nullable($inner:ident)) => { Option<$inner> };
    (Optional($inner:ident)) => { Option<$inner> };
    (OptionalNullable($inner:ident)) => { Option<$inner> };
    (Array($inner:ident)) => { Vec<$inner> };
    (Unit) => { () };
    ($name:ident) => { $name };
}

macro_rules! object {
    ($name:ident { $($(#[$attribute:meta])* $field:ident: $kind:ident $(($inner:ident))?),* $(,)? }) => {
        #[derive(Clone, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $($(#[$attribute])* pub $field: native_type!($kind $(($inner))?),)*
        }
    };
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident = $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
        pub enum $name {
            $(#[serde(rename = $value)] $variant,)+
        }
        impl $name {
            pub const fn name(self) -> &'static str {
                match self { $(Self::$variant => $value,)+ }
            }
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.name())
            }
        }
    };
}

macro_rules! number_enum {
    ($name:ident($number:ty) { $($variant:ident = $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy)]
        pub enum $name { $($variant,)+ }
        impl $name {
            pub const fn value(self) -> $number { match self { $(Self::$variant => $value,)+ } }
        }
        impl TryFrom<$number> for $name {
            type Error = ();
            fn try_from(value: $number) -> Result<Self, ()> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(()) }
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <$number as serde::Deserialize>::deserialize(deserializer)?;
                Self::try_from(value).map_err(|_| serde::de::Error::custom("unsupported numeric option"))
            }
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let value = self.value();
                serde::Serialize::serialize(&value, serializer)
            }
        }
    };
}

macro_rules! literal {
    ($name:ident, $kind:ty, $value:literal) => {
        #[derive(Clone, Copy)]
        pub struct $name;
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <$kind as serde::Deserialize>::deserialize(deserializer)?;
                if value == $value {
                    Ok(Self)
                } else {
                    Err(serde::de::Error::custom("unexpected literal"))
                }
            }
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let value: $kind = $value;
                serde::Serialize::serialize(&value, serializer)
            }
        }
    };
}

macro_rules! union {
    ($name:ident { $($variant:ident($kind:ident)),+ $(,)? }) => {
        #[derive(serde::Serialize, serde::Deserialize)]
        #[serde(untagged)]
        pub enum $name { $($variant($kind),)+ }
    };
}

macro_rules! ignore_command {
    ($($tokens:tt)*) => {};
}
desktop_ipc!(
    object,
    string_enum,
    number_enum,
    literal,
    union,
    ignore_command
);
pub(crate) use native_type;

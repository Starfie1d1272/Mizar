use crate::ipc_lifecycle_contract::ipc_lifecycle;

macro_rules! native_type {
    (Nullable($inner:ident)) => { Option<$inner> };
    (Optional($inner:ident)) => { Option<$inner> };
    (Unit) => { () };
    ($name:ident) => { $name };
}

macro_rules! object {
    ($name:ident { $($field:ident: $kind:ident $(($inner:ident))?),* $(,)? }) => {
        #[derive(Clone, serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $(pub $field: native_type!($kind $(($inner))?),)*
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
        impl TryFrom<$number> for $name {
            type Error = ();
            fn try_from(value: $number) -> Result<Self, ()> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(()) }
            }
        }
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let value: $number = match self { $(Self::$variant => $value,)+ };
                serde::Serialize::serialize(&value, serializer)
            }
        }
    };
}

macro_rules! literal {
    ($name:ident, $kind:ty, $value:literal) => {
        #[derive(Clone, Copy)]
        pub struct $name;
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
        #[derive(serde::Serialize)]
        #[serde(untagged)]
        pub enum $name { $($variant($kind),)+ }
    };
}

macro_rules! native_handler {
    (sync $name:ident($($arg:ident: $kind:ty),* $(,)?) -> $result:ty = $handler:path) => {
        #[tauri::command]
        pub(crate) fn $name($($arg: $kind),*) -> Result<$result, String> {
            $handler($($arg),*)
        }
    };
    (async $name:ident($($arg:ident: $kind:ty),* $(,)?) -> $result:ty = $handler:path) => {
        #[tauri::command]
        pub(crate) async fn $name($($arg: $kind),*) -> Result<$result, String> {
            $handler($($arg),*).await
        }
    };
}

macro_rules! command {
    ($execution:ident $name:ident $windows:ident
        ($($context:ident: $context_type:ty),* $(,)?) $mode:ident
        [$($arg:ident: $kind:ident $(($inner:ident))?),* $(,)?]
        ($($diagnostic:ident: $diagnostic_type:ty),* $(,)?)
        -> $result:ident $(($result_inner:ident))? = $handler:path
    ) => {
        native_handler!(
            $execution $name(
                $($context: $context_type,)*
                $($arg: native_type!($kind $(($inner))?),)*
                $($diagnostic: $diagnostic_type,)*
            ) -> native_type!($result $(($result_inner))?) = $handler
        );
    };
}

ipc_lifecycle!(object, string_enum, number_enum, literal, union, command);

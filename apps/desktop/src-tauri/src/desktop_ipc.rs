//! Native transport adapters generated from the shared desktop command contract.
use crate::desktop_types::{native_type, *};
use crate::ipc_contract::desktop_ipc;
use crate::{host_state::HostState, startup_log::DesktopLog};

macro_rules! native_handler {
    (sync $name:ident($($arg:ident: $kind:ty),* $(,)?) -> $result:ty = $handler:path) => {
        #[tauri::command]
        pub(crate) fn $name($($arg: $kind),*) -> Result<$result, serde_json::Value> {
            $handler($($arg),*).map_err(serde_json::Value::from)
        }
    };
    (async $name:ident($($arg:ident: $kind:ty),* $(,)?) -> $result:ty = $handler:path) => {
        #[tauri::command]
        pub(crate) async fn $name($($arg: $kind),*) -> Result<$result, serde_json::Value> {
            $handler($($arg),*).await.map_err(serde_json::Value::from)
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

macro_rules! ignore_declaration {
    ($($tokens:tt)*) => {};
}
desktop_ipc!(
    ignore_declaration,
    ignore_declaration,
    ignore_declaration,
    ignore_declaration,
    ignore_declaration,
    command
);

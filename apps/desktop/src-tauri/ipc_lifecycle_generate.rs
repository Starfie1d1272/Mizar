use crate::ipc_lifecycle_contract::ipc_lifecycle;
use std::fmt::Write;

fn camel(field: &str) -> String {
    let mut words = field.split('_');
    let mut key = words.next().expect("IPC field").to_owned();
    for word in words {
        let mut chars = word.chars();
        key.push(
            chars
                .next()
                .expect("IPC field segment")
                .to_ascii_uppercase(),
        );
        key.extend(chars);
    }
    key
}

macro_rules! schema {
    (String) => {
        "z.string()"
    };
    (bool) => {
        "z.boolean()"
    };
    (u32) => {
        "z.uint32()"
    };
    (Unit) => {
        "unit"
    };
    (Nullable($inner:ident)) => {
        concat!(schema!($inner), ".nullable()")
    };
    (Optional($inner:ident)) => {
        concat!(schema!($inner), ".optional()")
    };
    ($name:ident) => {
        stringify!($name)
    };
}

pub fn frontend_lifecycle() -> String {
    let mut output = String::from(
        "// Generated from desktop/src-tauri/ipc_lifecycle_contract.rs. Do not edit.\n\
         import { z } from 'zod';\n\n\
         const unit = z.null().transform(() => undefined);\n",
    );
    let mut commands = String::from("\nexport const desktopLifecycle = {\n");
    macro_rules! object {
        ($name:ident { $($field:ident: $kind:ident $(($inner:ident))?),* $(,)? }) => {{
            writeln!(output, "const {} = z.object({{", stringify!($name)).unwrap();
            $(writeln!(output, "  {}: {},", camel(stringify!($field)), schema!($kind $(($inner))?)).unwrap();)*
            output.push_str("});\n");
        }};
    }
    macro_rules! string_enum {
        ($name:ident { $($variant:ident = $value:literal),+ $(,)? }) => {{
            let values = [$($value),+].map(|value| format!("'{value}'"));
            let prefix = concat!("const ", stringify!($name), " = z.enum([");
            let joined = values.join(", ");
            if prefix.len() + joined.len() + 3 <= 100 {
                writeln!(output, "{prefix}{joined}]);").unwrap();
            } else {
                writeln!(output, "{prefix}").unwrap();
                for value in values {
                    writeln!(output, "  {value},").unwrap();
                }
                output.push_str("]);\n");
            }
        }};
    }
    macro_rules! number_enum {
        ($name:ident($number:ty) { $($variant:ident = $value:literal),+ $(,)? }) => {{
            let values = [$(concat!("z.literal(", stringify!($value), ")")),+];
            writeln!(output, "const {} = z.union([{}]);", stringify!($name), values.join(", ")).unwrap();
        }};
    }
    macro_rules! literal {
        ($name:ident, $kind:ty, $value:literal) => {
            writeln!(
                output,
                "const {} = z.literal({});",
                stringify!($name),
                $value
            )
            .unwrap();
        };
    }
    macro_rules! union {
        ($name:ident { $($variant:ident($kind:ident)),+ $(,)? }) => {
            writeln!(
                output, "const {} = z.union([{}]);", stringify!($name), [$(stringify!($kind)),+].join(", "),
            ).unwrap();
        };
    }
    macro_rules! command {
        ($execution:ident $name:ident $windows:ident $context:tt $mode:ident
            [$($arg:ident: $kind:ident $(($inner:ident))?),* $(,)?]
            $diagnostic:tt -> $result:ident $(($result_inner:ident))? = $handler:path
        ) => {{
            let fields: &[String] = &[$(format!("{}: {}", camel(stringify!($arg)), schema!($kind $(($inner))?))),*];
            let result = schema!($result $(($result_inner))?);
            let name = stringify!($name);
            if fields.is_empty() {
                writeln!(commands, "  {name}: {{ args: z.undefined(), result: {result} }},").unwrap();
            } else {
                writeln!(commands, "  {name}: {{").unwrap();
                if stringify!($mode) == "optional" {
                    writeln!(commands, "    args: z.strictObject({{ {} }}).optional(),", fields.join(", ")).unwrap();
                } else if fields.len() == 1 {
                    writeln!(commands, "    args: z.strictObject({{ {} }}),", fields[0]).unwrap();
                } else {
                    commands.push_str("    args: z.strictObject({\n");
                    for field in fields {
                        writeln!(commands, "      {field},").unwrap();
                    }
                    commands.push_str("    }),\n");
                }
                writeln!(commands, "    result: {result},\n  }},").unwrap();
            }
        }};
    }
    ipc_lifecycle!(object, string_enum, number_enum, literal, union, command);
    commands.push_str("};\n");
    output.push_str(&commands);
    output
}

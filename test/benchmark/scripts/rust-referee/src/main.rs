// Independent Rust oracle for the langquality benchmark, built on `syn` — the
// parser the Rust ecosystem's proc-macros use, a different implementation from
// koragraph's tree-sitter-rust, so a genuinely independent referee.
//   referee <repo> --out truth.json --mode decls|edges
//
// Rust has no class inheritance; the inheritance plane maps to `impl Trait for
// Type` (Type gains Trait — child=Type, base=Trait) and supertraits (`trait A:
// B` — child=A, base=B), Rust's real "X is-a / provides" relations.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use syn::visit::Visit;

#[derive(Default)]
struct Ref {
    file: String,
    cur_fn: Vec<String>,
    types: Vec<serde_json::Value>,
    methods: Vec<serde_json::Value>,
    fields: Vec<serde_json::Value>,
    constants: Vec<serde_json::Value>,
    imports: Vec<serde_json::Value>,
    inheritance: Vec<serde_json::Value>,
    calls: Vec<serde_json::Value>,
}

fn last_seg(p: &syn::Path) -> String {
    p.segments.last().map(|s| s.ident.to_string()).unwrap_or_default()
}

fn type_name(t: &syn::Type) -> Option<String> {
    if let syn::Type::Path(tp) = t { Some(last_seg(&tp.path)) } else { None }
}

impl Ref {
    fn caller(&self) -> Option<&str> { self.cur_fn.last().map(|s| s.as_str()) }
}

impl<'ast> Visit<'ast> for Ref {
    fn visit_item_struct(&mut self, i: &'ast syn::ItemStruct) {
        self.types.push(serde_json::json!({"file": self.file, "name": i.ident.to_string(), "kind": "struct"}));
        for f in &i.fields {
            if let Some(id) = &f.ident {
                self.fields.push(serde_json::json!({"file": self.file, "name": id.to_string()}));
            }
        }
        syn::visit::visit_item_struct(self, i);
    }
    fn visit_item_enum(&mut self, i: &'ast syn::ItemEnum) {
        self.types.push(serde_json::json!({"file": self.file, "name": i.ident.to_string(), "kind": "enum"}));
        syn::visit::visit_item_enum(self, i);
    }
    fn visit_item_trait(&mut self, i: &'ast syn::ItemTrait) {
        let name = i.ident.to_string();
        self.types.push(serde_json::json!({"file": self.file, "name": name, "kind": "trait"}));
        for b in &i.supertraits {
            if let syn::TypeParamBound::Trait(tb) = b {
                self.inheritance.push(serde_json::json!({"file": self.file, "child": name, "base": last_seg(&tb.path)}));
            }
        }
        syn::visit::visit_item_trait(self, i);
    }
    fn visit_item_impl(&mut self, i: &'ast syn::ItemImpl) {
        if let (Some((_, path, _)), Some(ty)) = (&i.trait_, type_name(&i.self_ty)) {
            self.inheritance.push(serde_json::json!({"file": self.file, "child": ty, "base": last_seg(path)}));
        }
        syn::visit::visit_item_impl(self, i);
    }
    fn visit_impl_item_fn(&mut self, i: &'ast syn::ImplItemFn) {
        let name = i.sig.ident.to_string();
        self.methods.push(serde_json::json!({"file": self.file, "name": name}));
        self.cur_fn.push(name);
        syn::visit::visit_impl_item_fn(self, i);
        self.cur_fn.pop();
    }
    fn visit_item_fn(&mut self, i: &'ast syn::ItemFn) {
        let name = i.sig.ident.to_string();
        self.methods.push(serde_json::json!({"file": self.file, "name": name}));
        self.cur_fn.push(name);
        syn::visit::visit_item_fn(self, i);
        self.cur_fn.pop();
    }
    fn visit_trait_item_fn(&mut self, i: &'ast syn::TraitItemFn) {
        self.methods.push(serde_json::json!({"file": self.file, "name": i.sig.ident.to_string()}));
        syn::visit::visit_trait_item_fn(self, i);
    }
    fn visit_item_const(&mut self, i: &'ast syn::ItemConst) {
        self.constants.push(serde_json::json!({"file": self.file, "name": i.ident.to_string()}));
        syn::visit::visit_item_const(self, i);
    }
    fn visit_item_static(&mut self, i: &'ast syn::ItemStatic) {
        self.constants.push(serde_json::json!({"file": self.file, "name": i.ident.to_string()}));
        syn::visit::visit_item_static(self, i);
    }
    fn visit_use_tree(&mut self, u: &'ast syn::UseTree) {
        match u {
            syn::UseTree::Name(n) => self.imports.push(serde_json::json!({"file": self.file, "name": n.ident.to_string()})),
            syn::UseTree::Rename(r) => self.imports.push(serde_json::json!({"file": self.file, "name": r.ident.to_string()})),
            _ => {}
        }
        syn::visit::visit_use_tree(self, u);
    }
    fn visit_expr_call(&mut self, e: &'ast syn::ExprCall) {
        if let syn::Expr::Path(p) = &*e.func {
            if let Some(c) = self.caller() {
                self.calls.push(serde_json::json!({"file": self.file, "caller": c, "callee": last_seg(&p.path)}));
            }
        }
        syn::visit::visit_expr_call(self, e);
    }
    fn visit_expr_method_call(&mut self, e: &'ast syn::ExprMethodCall) {
        if let Some(c) = self.caller() {
            self.calls.push(serde_json::json!({"file": self.file, "caller": c, "callee": e.method.to_string()}));
        }
        syn::visit::visit_expr_method_call(self, e);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let repo = args.iter().skip(1).find(|a| !a.starts_with("--")).cloned().unwrap_or_default();
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).cloned();
    let mode = args.iter().position(|a| a == "--mode").and_then(|i| args.get(i + 1)).cloned().unwrap_or("decls".into());
    let skip: HashSet<&str> = ["target", "tests", "test", "examples", "benches", ".git"].into_iter().collect();

    let mut r = Ref::default();
    let mut files = 0;
    let mut parse_errors: Vec<String> = vec![];
    for entry in walkdir::WalkDir::new(&repo).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("rs") { continue; }
        let rel = p.strip_prefix(&repo).unwrap_or(p).to_string_lossy().to_string();
        if rel.split('/').any(|s| skip.contains(s)) { continue; }
        let src = match fs::read_to_string(p) { Ok(s) => s, Err(_) => continue };
        match syn::parse_file(&src) {
            Ok(ast) => { r.file = rel; files += 1; r.visit_file(&ast); }
            Err(_) => parse_errors.push(rel),
        }
    }

    let result = if mode == "edges" {
        serde_json::json!({"imports": r.imports, "inheritance": r.inheritance, "calls": r.calls, "parse_errors": parse_errors, "files": files, "referee": "rust-syn"})
    } else {
        serde_json::json!({"lang": "rust", "referee": "rust-syn", "files": files, "parse_errors": parse_errors,
            "types": r.types, "methods": r.methods, "fields": r.fields, "constants": r.constants,
            "counts": {"files": files, "types": r.types.len(), "methods": r.methods.len(), "fields": r.fields.len(), "constants": r.constants.len(), "parse_errors": parse_errors.len()}})
    };
    eprintln!("[{}] {} files, types={} methods={} imports={} inheritance={} calls={}", mode, files, r.types.len(), r.methods.len(), r.imports.len(), r.inheritance.len(), r.calls.len());
    if let Some(o) = out { fs::write(o, serde_json::to_string(&result).unwrap()).unwrap(); }
}

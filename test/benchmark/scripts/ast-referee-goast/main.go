// PRIMARY ground truth for Go — from Go's own compiler front end (go/parser + go/ast).
//
// Why this exists. Koragraph's Go path is tree-sitter and so is Graphify's, so a tree-sitter
// referee grades two systems that share a grammar — the situation the TypeScript section
// identified and the C# section proved dangerous. Go is the best case in this programme for a
// compiler-grade oracle: unlike clang it needs no build configuration, no include paths and no
// resolved imports. go/parser reads a single file, ignores build constraints, and produces the
// same syntax tree the compiler does.
//
// TAXONOMY — fixed here, before any measurement, and mirrored in ast-referee-ctags.py --lang go.
//
//	types      every type_spec in a `type` declaration: struct, interface, a defined type over
//	           any other underlying type (`type Duration int64`, `type HandlerFunc func()`),
//	           and an alias (`type X = Y`).
//	methods    `func F()`, `func (r T) M()`, and an interface method specification. Go's spec
//	           makes an interface's method set part of its declaration surface, and Universal
//	           Ctags gives it a dedicated kind (`methodSpec`), so both referees can adjudicate it.
//	fields     struct fields, named and embedded. An embedded field's name IS the unqualified
//	           type name (Go spec, "Struct types"), so `struct{ sync.Mutex }` declares `Mutex`.
//	constants  package-level `const` and `var`. This is the module-constants plane the other six
//	           languages already have: a top-level binding that is neither a type nor a callable.
//
// Excluded, and why: declarations inside a function body (locals — every other language in this
// programme excludes function-body bindings, and ctags does not emit them for Go either);
// parameters and receivers; the package clause and import specs (a file/import plane, not a
// declaration of a program entity); and the blank identifier `_`, which has no stable name to
// match on — `var _ Foo = (*Bar)(nil)` interface assertions would otherwise collide by the
// dozen inside one file.
//
//	go run . <repoPath> --out truth.json
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "target": true, "build": true,
	"vendor": true, ".gradle": true, "out": true,
}

type decl struct {
	File    string `json:"file"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Line    int    `json:"line"`
	EndLine int    `json:"end_line,omitempty"`
	Owner   string `json:"owner,omitempty"`
	Params  string `json:"params,omitempty"`
	Type    string `json:"type,omitempty"`
}

type output struct {
	Repo        string         `json:"repo"`
	Lang        string         `json:"lang"`
	Referee     string         `json:"referee"`
	Version     string         `json:"referee_version"`
	Files       int            `json:"files"`
	ParseErrors int            `json:"parse_errors"`
	TotalBytes  int            `json:"total_bytes"`
	ErrorBytes  int            `json:"error_bytes"`
	ErrorFiles  []string       `json:"error_files"`
	Types       []decl         `json:"types"`
	Methods     []decl         `json:"methods"`
	Fields      []decl         `json:"fields"`
	Constants   []decl         `json:"constants"`
	Counts      map[string]any `json:"counts"`
	Kinds       map[string]int `json:"kind_breakdown"`
}

// An embedded field's name is the unqualified type name: `*pkg.T` declares a field `T`.
func embeddedName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return embeddedName(t.X)
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.IndexExpr: // generic embed: `Base[T]`
		return embeddedName(t.X)
	case *ast.IndexListExpr:
		return embeddedName(t.X)
	}
	return ""
}

func exprText(fset *token.FileSet, src []byte, e ast.Expr) string {
	if e == nil {
		return ""
	}
	lo := fset.Position(e.Pos()).Offset
	hi := fset.Position(e.End()).Offset
	if lo < 0 || hi > len(src) || lo >= hi {
		return ""
	}
	return strings.Join(strings.Fields(string(src[lo:hi])), " ")
}

func paramText(fset *token.FileSet, src []byte, fl *ast.FieldList) string {
	if fl == nil {
		return ""
	}
	lo := fset.Position(fl.Pos()).Offset
	hi := fset.Position(fl.End()).Offset
	if lo < 0 || hi > len(src) || lo >= hi {
		return ""
	}
	return strings.Join(strings.Fields(strings.Trim(string(src[lo:hi]), "()")), " ")
}

func main() {
	repo := os.Args[1]
	outPath := ""
	for i, a := range os.Args {
		if a == "--out" && i+1 < len(os.Args) {
			outPath = os.Args[i+1]
		}
	}

	// The toolchain that built this binary IS the referee: go/parser ships inside it, so
	// runtime.Version() is the version of the grammar that produced this truth set. Without it
	// a published number carries no provenance and a reader cannot tell whether a disagreement
	// is their Go or our extraction.
	out := output{Repo: repo, Lang: "go", Referee: "go/parser (Go compiler front end)",
		Version: runtime.Version(),
		ErrorFiles: []string{}, Types: []decl{}, Methods: []decl{},
		Fields: []decl{}, Constants: []decl{}}

	var paths []string
	filepath.WalkDir(repo, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(p, ".go") {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)

	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(repo, p)
		out.Files++
		out.TotalBytes += len(src)

		fset := token.NewFileSet()
		// SkipObjectResolution: this referee asks a purely syntactic question, and object
		// resolution is both slow and irrelevant to it.
		f, perr := parser.ParseFile(fset, p, src, parser.SkipObjectResolution)
		if perr != nil {
			out.ParseErrors++
			out.ErrorBytes += len(src)
			out.ErrorFiles = append(out.ErrorFiles, rel)
		}
		if f == nil {
			continue
		}
		line := func(pos token.Pos) int { return fset.Position(pos).Line }

		for _, d := range f.Decls {
			switch dd := d.(type) {

			case *ast.FuncDecl:
				if dd.Name == nil || dd.Name.Name == "_" {
					continue
				}
				owner, kind := "", "function"
				if dd.Recv != nil && len(dd.Recv.List) > 0 {
					owner = embeddedName(dd.Recv.List[0].Type)
					kind = "method"
				}
				out.Methods = append(out.Methods, decl{
					File: rel, Name: dd.Name.Name, Kind: kind, Owner: owner,
					Params:  paramText(fset, src, dd.Type.Params),
					Line:    line(dd.Pos()),
					EndLine: line(dd.End()),
				})

			case *ast.GenDecl:
				for _, s := range dd.Specs {
					switch sp := s.(type) {

					case *ast.TypeSpec:
						if sp.Name == nil || sp.Name.Name == "_" {
							continue
						}
						kind := "type"
						if sp.Assign.IsValid() {
							kind = "talias"
						}
						switch ut := sp.Type.(type) {
						case *ast.StructType:
							if kind != "talias" {
								kind = "struct"
							}
							collectStructFields(fset, src, ut, sp.Name.Name, rel, &out)
						case *ast.InterfaceType:
							if kind != "talias" {
								kind = "interface"
							}
							collectInterfaceMethods(fset, src, ut, sp.Name.Name, rel, &out)
						}
						out.Types = append(out.Types, decl{
							File: rel, Name: sp.Name.Name, Kind: kind,
							Line: line(sp.Pos()), EndLine: line(sp.End()),
						})

					case *ast.ValueSpec:
						k := "var"
						if dd.Tok == token.CONST {
							k = "const"
						}
						for _, n := range sp.Names {
							if n == nil || n.Name == "_" {
								continue
							}
							out.Constants = append(out.Constants, decl{
								File: rel, Name: n.Name, Kind: k, Line: line(n.Pos()),
								Type: exprText(fset, src, sp.Type),
							})
						}
					}
				}
			}
		}
	}

	kinds := map[string]int{}
	for plane, items := range map[string][]decl{
		"types": out.Types, "methods": out.Methods,
		"fields": out.Fields, "constants": out.Constants,
	} {
		for _, it := range items {
			kinds[plane+":"+it.Kind]++
		}
	}
	out.Kinds = kinds
	errPct := 0.0
	if out.TotalBytes > 0 {
		errPct = float64(int(10000*float64(out.ErrorBytes)/float64(out.TotalBytes))) / 100
	}
	out.Counts = map[string]any{
		"files": out.Files, "types": len(out.Types), "methods": len(out.Methods),
		"fields": len(out.Fields), "constants": len(out.Constants),
		"parse_errors": out.ParseErrors, "error_byte_pct": errPct,
	}

	if outPath != "" {
		b, _ := json.Marshal(out)
		os.WriteFile(outPath, b, 0o644)
	}
	summary, _ := json.MarshalIndent(map[string]any{"counts": out.Counts, "kinds": out.Kinds}, "", "  ")
	fmt.Println(string(summary))
}

func collectStructFields(fset *token.FileSet, src []byte, st *ast.StructType, owner, rel string, out *output) {
	if st.Fields == nil {
		return
	}
	for _, fld := range st.Fields.List {
		ln := fset.Position(fld.Pos()).Line
		ftype := exprText(fset, src, fld.Type)
		if len(fld.Names) == 0 {
			if n := embeddedName(fld.Type); n != "" && n != "_" {
				out.Fields = append(out.Fields, decl{
					File: rel, Name: n, Kind: "anonMember", Owner: owner, Line: ln, Type: ftype,
				})
			}
			continue
		}
		for _, n := range fld.Names {
			if n.Name == "_" {
				continue
			}
			out.Fields = append(out.Fields, decl{
				File: rel, Name: n.Name, Kind: "member", Owner: owner,
				Line: fset.Position(n.Pos()).Line, Type: ftype,
			})
		}
	}
}

func collectInterfaceMethods(fset *token.FileSet, src []byte, it *ast.InterfaceType, owner, rel string, out *output) {
	if it.Methods == nil {
		return
	}
	for _, fld := range it.Methods.List {
		// An entry with no name is an embedded interface or a type-set element (`~int | string`),
		// not a method specification. ctags agrees: it emits nothing for those.
		for _, n := range fld.Names {
			if n.Name == "_" {
				continue
			}
			params := ""
			if ft, ok := fld.Type.(*ast.FuncType); ok {
				params = paramText(fset, src, ft.Params)
			}
			out.Methods = append(out.Methods, decl{
				File: rel, Name: n.Name, Kind: "methodSpec", Owner: owner,
				Params: params, Line: fset.Position(n.Pos()).Line,
				EndLine: fset.Position(fld.End()).Line,
			})
		}
	}
}

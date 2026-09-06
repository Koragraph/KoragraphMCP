// Ground truth for the EDGE planes of a Go repository, from Go's own compiler front end.
//
// The declaration referee next door (ast-referee-goast/) grades the NODES of a code graph. This
// one grades the edges — the part that makes it a graph rather than a symbol table, and the part
// a blast-radius or call-chain query actually traverses. It is the Go sibling of
// edge-referee-cpython.py and emits the identical JSON shape so one scorer serves both.
//
// Same referee philosophy as the declaration benchmark: the language's own parser, no build
// configuration, no module resolution, no type checking. go/parser reads a single file exactly
// as written, ignores build constraints, and produces the same syntax tree the compiler does.
// Go is the best case in this programme for a compiler-grade oracle precisely because none of
// that resolution machinery is needed to get the tree.
//
// Three planes, each chosen because go/ast answers it EXACTLY — no heuristics, no guesses:
//
//	imports      (file, name)             one row per ImportSpec; `name` is the FULL import path
//	                                      ("github.com/spf13/pflag"), not a truncated component.
//	                                      The Python referee truncates `import a.b.c` to `a`
//	                                      because a Python module path is a dotted chain of real
//	                                      packages; a Go import path is one atomic package
//	                                      identifier and cutting it at the first slash would
//	                                      collapse every dependency on one host into a single
//	                                      edge. Full paths are losslessly truncatable by a
//	                                      scorer; the reverse is not true, so the referee keeps
//	                                      the information and lets the scorer decide.
//
//	inheritance  (file, child, base)      Go has no `extends`. EMBEDDING IS THE INHERITANCE
//	                                      ANALOGUE and is what this plane records: an embedded
//	                                      field in a struct (`type S struct { sync.Mutex }` ->
//	                                      S -> Mutex) and an embedded interface in an interface
//	                                      (`type RW interface { Reader; Writer }` -> RW ->
//	                                      Reader, RW -> Writer). Both are the mechanism by which
//	                                      a Go type acquires another type's method set, which is
//	                                      the property an inheritance edge exists to express.
//
//	                                      NOT emitted: interface satisfaction. In Go it is
//	                                      STRUCTURAL — `*T` implements `io.Reader` by having the
//	                                      right method, with nothing written in the source that
//	                                      says so. Deciding it requires a full type checker and a
//	                                      resolved package graph, i.e. exactly the build
//	                                      configuration this referee refuses to depend on. A
//	                                      referee that guessed at it would be grading our guess
//	                                      against another system's guess. The tradeoff is real
//	                                      and is stated rather than hidden: this plane
//	                                      under-reports what a Go engineer would call an
//	                                      "implements" relationship, and any system scored
//	                                      against it must be scored on embedding only.
//
//	                                      Type-set elements in a constraint interface
//	                                      (`~int | string`) are also excluded — they are a set of
//	                                      permitted underlying types, not an acquired method set.
//
//	calls        (file, caller, callee)   a CallExpr. `caller` is the enclosing FuncDecl's own
//	                                      name (bare `M`, not `T.M`, mirroring the Python
//	                                      referee, which pushes the bare def name), or
//	                                      "<package>" for a call in a package-level var/const
//	                                      initialiser — the Go analogue of the Python referee's
//	                                      "<module>". A function literal does NOT open a new
//	                                      caller scope, mirroring the Python referee's treatment
//	                                      of a lambda; calls inside a closure attribute to the
//	                                      function that contains it.
//
//	                                      `callee` is the FINAL COMPONENT of the called
//	                                      expression: `pflag.NewFlagSet` -> `NewFlagSet`,
//	                                      `c.Run` -> `Run`, `Min[int]` -> `Min`. NAME-LEVEL,
//	                                      deliberately. go/ast alone cannot say which `Run` is
//	                                      meant without type-checking the whole program, so
//	                                      anything stricter would score our resolution guess
//	                                      against another system's.
//
//	                                      Consequence of name-level, stated because it inflates
//	                                      this plane: a Go conversion `MyInt(x)` and a builtin
//	                                      `len(x)` are syntactically indistinguishable from a
//	                                      call and are counted. So is `T{}`-free construction via
//	                                      a constructor func. A composite literal `T{...}` is NOT
//	                                      a CallExpr and is not counted.
//
// PARSE FAILURES: recorded in parse_errors, never silently dropped. Unlike CPython's `ast`, which
// is all-or-nothing on a SyntaxError, go/parser does error recovery and returns a usable partial
// tree. This referee therefore flags the file AND emits what did parse, so a scorer can either
// exclude those files or accept the partial rows — but cannot fail to notice them.
//
// `skipDirs` mirrors edge-referee-cpython.py's SKIP set exactly, plus Go build output dirs, so
// every side of the comparison sees the same files.
//
// Zero network, zero LLM.
//
//	go build -o referee . && ./referee <checkout> --out truth-edges.json
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
	"strconv"
	"strings"
)

// Identical to edge-referee-cpython.py's SKIP, plus Go's build output dirs. The Python entries
// that cannot occur in a Go tree are kept anyway: the point is that both referees skip the same
// path in a polyglot checkout, not that each entry is reachable in each language.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "target": true, "build": true,
	"vendor": true, ".gradle": true, "out": true, ".gitnexus": true,
	"graphify-out": true, ".venv": true, "venv": true, "__pycache__": true,
	".tox": true, ".mypy_cache": true,
	// Go build output. `pkg` and `internal` are NOT here — both are ordinary source
	// directories in the great majority of Go repositories.
	"bin": true,
}

type importRow struct {
	File string `json:"file"`
	Name string `json:"name"`
}

type inheritRow struct {
	File  string `json:"file"`
	Child string `json:"child"`
	Base  string `json:"base"`
}

type callRow struct {
	File   string `json:"file"`
	Caller string `json:"caller"`
	Callee string `json:"callee"`
}

// Field order and key set match edge-referee-cpython.py's output object exactly.
type output struct {
	Imports     []importRow  `json:"imports"`
	Inheritance []inheritRow `json:"inheritance"`
	Calls       []callRow    `json:"calls"`
	ParseErrors []string     `json:"parse_errors"`
	Files       int          `json:"files"`
	Referee     string       `json:"referee"`
	Version     string       `json:"referee_version"`
}

// finalName returns the last component of a called or embedded expression, or "".
// The Go analogue of the Python referee's `final()`: ast.Name -> id, ast.Attribute -> attr.
func finalName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.StarExpr: // `*pkg.T` embedded by pointer
		return finalName(t.X)
	case *ast.ParenExpr:
		return finalName(t.X)
	case *ast.IndexExpr: // instantiated generic: `Base[T]`, `Min[int]`
		return finalName(t.X)
	case *ast.IndexListExpr: // `Base[K, V]`
		return finalName(t.X)
	}
	// Everything else — func literals invoked in place, `[]byte(x)`, `interface{}(x)` — has no
	// name to report. Returning "" drops the row rather than inventing one.
	return ""
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: referee <checkout> --out truth-edges.json")
		os.Exit(2)
	}
	checkout := os.Args[1]
	outPath := ""
	for i, a := range os.Args {
		if a == "--out" && i+1 < len(os.Args) {
			outPath = os.Args[i+1]
		}
	}
	if outPath == "" {
		fmt.Fprintln(os.Stderr, "usage: referee <checkout> --out truth-edges.json")
		os.Exit(2)
	}

	// The toolchain that built this binary IS the referee: go/parser ships inside it, so
	// runtime.Version() is the version of the grammar that produced this truth set. Without it
	// a published number carries no provenance.
	out := output{
		Imports: []importRow{}, Inheritance: []inheritRow{}, Calls: []callRow{},
		ParseErrors: []string{},
		Referee:     "go/parser (Go compiler front end)",
		Version:     runtime.Version(),
	}

	var paths []string
	filepath.WalkDir(checkout, func(p string, d fs.DirEntry, err error) error {
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
		rel, _ := filepath.Rel(checkout, p)
		out.Files++

		fset := token.NewFileSet()
		// SkipObjectResolution: this referee asks a purely syntactic question, and object
		// resolution is both slow and irrelevant to it.
		f, perr := parser.ParseFile(fset, p, src, parser.SkipObjectResolution)
		if perr != nil {
			out.ParseErrors = append(out.ParseErrors, rel)
		}
		if f == nil {
			continue
		}
		walkFile(f, rel, &out)
	}

	b, _ := json.Marshal(out)
	if err := os.WriteFile(outPath, b, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr,
		"[edge-truth] %d files: %d imports, %d inheritance, %d calls, %d parse errors -> %s\n",
		out.Files, len(out.Imports), len(out.Inheritance), len(out.Calls),
		len(out.ParseErrors), outPath)
}

func walkFile(f *ast.File, rel string, out *output) {
	for _, spec := range f.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			path = strings.Trim(spec.Path.Value, "`\"")
		}
		if path != "" {
			out.Imports = append(out.Imports, importRow{File: rel, Name: path})
		}
	}

	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		for _, s := range gd.Specs {
			sp, ok := s.(*ast.TypeSpec)
			if !ok || sp.Name == nil || sp.Name.Name == "_" {
				continue
			}
			collectEmbedded(sp.Name.Name, sp.Type, rel, out)
		}
	}

	// Caller scope. A FuncDecl opens one; a FuncLit deliberately does not — see the header.
	caller := "<package>"
	var visit func(n ast.Node) bool
	visit = func(n ast.Node) bool {
		switch t := n.(type) {
		case *ast.FuncDecl:
			if t.Name == nil {
				return true
			}
			prev := caller
			caller = t.Name.Name
			if t.Body != nil {
				ast.Inspect(t.Body, visit)
			}
			// Default values and types in the signature can contain calls too
			// (`func f(x = g())` is not Go, but a generic constraint can hold none) —
			// nothing to walk here, so restore and stop descending.
			caller = prev
			return false
		case *ast.CallExpr:
			if nm := finalName(t.Fun); nm != "" {
				out.Calls = append(out.Calls, callRow{File: rel, Caller: caller, Callee: nm})
			}
			return true
		}
		return true
	}
	ast.Inspect(f, visit)
}

// A type declaration contributes inheritance rows only through embedding: an unnamed struct
// field, or an unnamed entry in an interface body. Both are how a Go type acquires another
// type's method set.
func collectEmbedded(child string, t ast.Expr, rel string, out *output) {
	switch ty := t.(type) {
	case *ast.StructType:
		if ty.Fields == nil {
			return
		}
		for _, fld := range ty.Fields.List {
			if len(fld.Names) != 0 { // named field: composition by reference, not embedding
				continue
			}
			if nm := finalName(fld.Type); nm != "" && nm != "_" {
				out.Inheritance = append(out.Inheritance,
					inheritRow{File: rel, Child: child, Base: nm})
			}
		}
	case *ast.InterfaceType:
		if ty.Methods == nil {
			return
		}
		for _, fld := range ty.Methods.List {
			if len(fld.Names) != 0 { // a method specification, not an embedded interface
				continue
			}
			// A type-set element (`~int | string`, a *ast.BinaryExpr or *ast.UnaryExpr)
			// is unnamed too, but it is a constraint on underlying types, not an acquired
			// method set. finalName returns "" for both, which drops them.
			if nm := finalName(fld.Type); nm != "" && nm != "_" {
				out.Inheritance = append(out.Inheritance,
					inheritRow{File: rel, Child: child, Base: nm})
			}
		}
	}
}

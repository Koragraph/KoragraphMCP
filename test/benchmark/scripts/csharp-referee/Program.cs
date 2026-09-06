using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// Independent C# oracle for the langquality benchmark, built on Roslyn — the C#
// compiler's own parser, a different implementation from koragraph's
// tree-sitter-c_sharp, so a genuinely independent referee.
//   dotnet run -c Release -- <repo> --out truth.json --mode decls|edges

class Referee
{
    static string[] SKIP = { "obj", "bin", "test", "tests", "Test", "Tests", ".git", "node_modules", "packages", "samples", "benchmarks" };

    static string Final(string n)
    {
        var s = n.Split('.').Last();
        return s.Trim();
    }

    static string TypeName(BaseTypeSyntax b)
    {
        var t = b.Type.ToString();
        // strip generic args for the final name
        var lt = t.IndexOf('<');
        if (lt >= 0) t = t.Substring(0, lt);
        return Final(t);
    }

    static void Main(string[] args)
    {
        string repo = args.FirstOrDefault(a => !a.StartsWith("--"));
        string outPath = null; string mode = "decls";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[i + 1];
            if (args[i] == "--mode" && i + 1 < args.Length) mode = args[i + 1];
        }

        var types = new List<object>(); var methods = new List<object>(); var fields = new List<object>(); var constants = new List<object>();
        var imports = new List<object>(); var inheritance = new List<object>(); var calls = new List<object>();
        int fileCount = 0; var parseErrors = new List<string>();

        foreach (var path in Directory.EnumerateFiles(repo, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(repo, path).Replace('\\', '/');
            if (rel.Split('/').Any(seg => SKIP.Contains(seg))) continue;
            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(File.ReadAllText(path)).GetRoot(); }
            catch { parseErrors.Add(rel); continue; }
            fileCount++;

            foreach (var u in root.DescendantNodes().OfType<UsingDirectiveSyntax>())
                if (u.Name != null) imports.Add(new { file = rel, name = u.Name.ToString() });

            foreach (var t in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
            {
                var kind = t is InterfaceDeclarationSyntax ? "interface" : t is StructDeclarationSyntax ? "struct" : t is RecordDeclarationSyntax ? "record" : "class";
                types.Add(new { file = rel, name = t.Identifier.Text, kind });
                if (t.BaseList != null)
                    foreach (var b in t.BaseList.Types)
                        inheritance.Add(new { file = rel, child = t.Identifier.Text, @base = TypeName(b) });
            }
            foreach (var e in root.DescendantNodes().OfType<EnumDeclarationSyntax>())
                types.Add(new { file = rel, name = e.Identifier.Text, kind = "enum" });

            foreach (var m in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
                methods.Add(new { file = rel, name = m.Identifier.Text });
            foreach (var c in root.DescendantNodes().OfType<ConstructorDeclarationSyntax>())
                methods.Add(new { file = rel, name = c.Identifier.Text });
            foreach (var p in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
                fields.Add(new { file = rel, name = p.Identifier.Text });
            foreach (var f in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
            {
                bool isConst = f.Modifiers.Any(mm => mm.Text == "const");
                foreach (var v in f.Declaration.Variables)
                {
                    if (isConst) constants.Add(new { file = rel, name = v.Identifier.Text });
                    else fields.Add(new { file = rel, name = v.Identifier.Text });
                }
            }

            string CallerOf(SyntaxNode n)
            {
                for (var a = n.Parent; a != null; a = a.Parent)
                {
                    if (a is MethodDeclarationSyntax md) return md.Identifier.Text;
                    if (a is ConstructorDeclarationSyntax cd) return cd.Identifier.Text;
                    if (a is TypeDeclarationSyntax td) return td.Identifier.Text;
                }
                return null;
            }
            foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                string callee = inv.Expression switch
                {
                    MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
                    IdentifierNameSyntax id => id.Identifier.Text,
                    _ => null
                };
                var caller = CallerOf(inv);
                if (callee != null && caller != null) calls.Add(new { file = rel, caller, callee });
            }
            foreach (var oc in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                var caller = CallerOf(oc);
                var callee = Final(oc.Type.ToString().Split('<')[0]);
                if (!string.IsNullOrEmpty(callee) && caller != null) calls.Add(new { file = rel, caller, callee });
            }
        }

        object result;
        if (mode == "edges")
            result = new { imports, inheritance, calls, parse_errors = parseErrors, files = fileCount, referee = "roslyn" };
        else
            result = new
            {
                repo, lang = "csharp", referee = "roslyn", files = fileCount, parse_errors = parseErrors,
                types, methods, fields, constants,
                counts = new { files = fileCount, types = types.Count, methods = methods.Count, fields = fields.Count, constants = constants.Count, parse_errors = parseErrors.Count }
            };
        var json = JsonSerializer.Serialize(result);
        if (outPath != null) File.WriteAllText(outPath, json);
        Console.Error.WriteLine($"[{mode}] {fileCount} files, types={types.Count} methods={methods.Count} imports={imports.Count} inheritance={inheritance.Count} calls={calls.Count}");
    }
}

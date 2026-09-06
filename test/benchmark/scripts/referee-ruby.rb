#!/usr/bin/env ruby
# frozen_string_literal: true

# Independent Ruby oracle for the langquality benchmark, built on
# RubyVM::AbstractSyntaxTree — the parser MRI itself compiles from, a completely
# different implementation from koragraph's tree-sitter-ruby, so it is a genuinely
# independent referee (and far more robust than Ripper.sexp, which returns nil on
# many real files). Needs Ruby 3.x; run with /opt/homebrew/opt/ruby/bin/ruby.
#
#   ruby scripts/referee-ruby.rb <repo> --out truth.json --mode decls|edges
#
# Inheritance = a superclass (`class X < Y`) or a mixin (`include`/`extend`/
# `prepend M`) — Ruby's real ancestor-chain contributions.

require 'json'

repo = ARGV.first
out_path = ARGV.include?('--out') ? ARGV[ARGV.index('--out') + 1] : nil
mode = ARGV.include?('--mode') ? ARGV[ARGV.index('--mode') + 1] : 'decls'
SKIP = %w[.git spec test tests vendor node_modules tmp .bundle examples].freeze
N = RubyVM::AbstractSyntaxTree::Node

def const_name(node)
  return nil unless node.is_a?(N)
  node.children.reverse_each.find { |c| c.is_a?(Symbol) }&.to_s
end

def collect(node, type, field = 0)
  out = []
  w = lambda do |n|
    return unless n.is_a?(N)
    out << n.children[field] if n.type == type
    n.children.each { |c| w.call(c) }
  end
  w.call(node)
  out
end

def emit(node, file, cls, meth, res)
  return unless node.is_a?(N)
  case node.type
  when :CLASS
    name = const_name(node.children[0])
    if name
      res[:types] << { file: file, name: name, kind: 'class', line: node.first_lineno }
      base = const_name(node.children[1]) if node.children[1]
      res[:inheritance] << { file: file, child: name, base: base } if base
    end
    emit(node.children[2], file, name || cls, nil, res)
    return
  when :MODULE
    name = const_name(node.children[0])
    res[:types] << { file: file, name: name, kind: 'module', line: node.first_lineno } if name
    emit(node.children[1], file, name || cls, nil, res)
    return
  when :DEFN
    res[:methods] << { file: file, name: node.children[0].to_s, line: node.first_lineno }
    emit(node.children[1], file, cls, node.children[0].to_s, res)
    return
  when :DEFS
    res[:methods] << { file: file, name: node.children[1].to_s, line: node.first_lineno }
    emit(node.children[2], file, cls, node.children[1].to_s, res)
    return
  when :CDECL
    nm = node.children.find { |c| c.is_a?(Symbol) }
    res[:constants] << { file: file, name: nm.to_s, line: node.first_lineno } if nm
  when :FCALL
    callee = node.children[0].to_s
    args = node.children[1]
    if %w[include extend prepend].include?(callee) && cls
      collect(args, :CONST).each { |m| res[:inheritance] << { file: file, child: cls, base: m.to_s } }
      collect(args, :COLON2).each { |_| }
    elsif %w[require require_relative].include?(callee)
      collect(args, :STR).each { |s| res[:imports] << { file: file, name: File.basename(s.to_s, '.rb') } }
    elsif %w[attr_accessor attr_reader attr_writer].include?(callee) && cls
      (collect(args, :LIT) + collect(args, :SYM)).each { |s| res[:fields] << { file: file, name: s.to_s } }
    elsif meth || cls
      res[:calls] << { file: file, caller: meth || cls, callee: callee }
    end
  when :VCALL
    res[:calls] << { file: file, caller: meth || cls, callee: node.children[0].to_s } if meth || cls
  when :CALL, :OPCALL, :QCALL
    sym = node.children.find { |c| c.is_a?(Symbol) }
    res[:calls] << { file: file, caller: meth || cls, callee: sym.to_s } if sym && (meth || cls)
  end
  node.children.each { |c| emit(c, file, cls, meth, res) if c.is_a?(N) }
end

RES = { types: [], methods: [], fields: [], constants: [], imports: [], inheritance: [], calls: [] }
files = []
parse_errors = []
Dir.glob(File.join(repo, '**', '*.rb')).sort.each do |path|
  rel = path.sub(%r{^#{Regexp.escape(repo)}/?}, '')
  next if SKIP.any? { |s| rel.split('/').include?(s) }
  begin
    ast = RubyVM::AbstractSyntaxTree.parse(File.read(path, encoding: 'UTF-8'))
  rescue SyntaxError, EncodingError, StandardError
    parse_errors << rel
    next
  end
  files << rel
  emit(ast, rel, nil, nil, RES)
end

if mode == 'edges'
  out = { imports: RES[:imports], inheritance: RES[:inheritance], calls: RES[:calls],
          parse_errors: parse_errors, files: files.size, referee: 'ruby-ast', referee_version: RUBY_VERSION }
  warn "[edge-truth] #{files.size} files: #{RES[:imports].size} imports, " \
       "#{RES[:inheritance].size} inheritance, #{RES[:calls].size} calls, #{parse_errors.size} parse errors"
else
  counts = { files: files.size, types: RES[:types].size, methods: RES[:methods].size,
             fields: RES[:fields].size, constants: RES[:constants].size, parse_errors: parse_errors.size }
  out = { repo: repo, lang: 'ruby', referee: 'ruby-ast', referee_version: RUBY_VERSION,
          files: files.size, parse_errors: parse_errors,
          types: RES[:types], methods: RES[:methods], fields: RES[:fields], constants: RES[:constants], counts: counts }
  warn "[decl-truth] #{JSON.generate(counts)}"
end
File.write(out_path, JSON.generate(out)) if out_path

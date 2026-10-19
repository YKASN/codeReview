"""Parse saved source bytes using stdlib AST; never import inspected modules."""
import ast
import io
import json
import pathlib
import sys
import tokenize

request = json.load(sys.stdin)
result = {"structures": [], "imports": [], "calls": [], "diagnostics": [], "files": []}
parser = "python-ast/" + sys.version.split()[0]

for file in request["files"]:
    file_id = file["id"]
    try:
        data = (pathlib.Path(request["directory"]) / file["source"]).read_bytes()
        encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
        source = data.decode(encoding)
        tree = ast.parse(source, filename=file["path"])
        lines = source.split("\n")
        byte_lines = [line.encode("utf-8") for line in lines]
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
        names_by_line = {}
        for token in tokens:
            if token.type == tokenize.NAME:
                names_by_line.setdefault(token.start[0], []).append(token)
        scopes = []

        def span(node):
            return [node.lineno - 1, node.col_offset, node.end_lineno - 1, node.end_col_offset]

        def segment(node):
            if node is None:
                return None
            start, end = node.lineno - 1, node.end_lineno - 1
            if start == end:
                return byte_lines[start][node.col_offset:node.end_col_offset].decode("utf-8")
            return b"\n".join([byte_lines[start][node.col_offset:], *byte_lines[start + 1:end], byte_lines[end][:node.end_col_offset]]).decode("utf-8")

        def name_span(node, name):
            for token in names_by_line.get(node.lineno, []):
                if token.string == name and len(lines[token.start[0] - 1][:token.start[1]].encode("utf-8")) >= node.col_offset:
                    return [token.start[0] - 1, len(lines[token.start[0] - 1][:token.start[1]].encode("utf-8")), token.end[0] - 1, len(lines[token.end[0] - 1][:token.end[1]].encode("utf-8"))]
            return None

        def add(kind, node=None, name=None, name_range=None, **extra):
            index = len(result["structures"])
            record = {"file_id": file_id, "parser": parser, "position_encoding": "UTF8CodeUnitOffsetFromLineStart", "kind": kind,
                      "name": name, "range": span(node) if node is not None else [0, 0, len(lines) - 1, len(lines[-1].encode("utf-8"))],
                      "name_range": name_range, "parent_index": scopes[-1] if scopes else None, **extra}
            decorators = getattr(node, "decorator_list", [])
            if decorators:
                record["range"][0] = decorators[0].lineno - 1
                record["range"][1] = max(0, decorators[0].col_offset - 1)
            result["structures"].append(record)
            return index

        module = add("module", name=file["path"])
        scopes.append(module)

        class Visitor(ast.NodeVisitor):
            def function(self, node):
                parameters = []
                positional = list(node.args.posonlyargs) + list(node.args.args)
                defaults = [None] * (len(positional) - len(node.args.defaults)) + list(node.args.defaults)
                for argument, default in zip(positional, defaults):
                    parameters.append({"name": argument.arg, "kind": "positional-only" if argument in node.args.posonlyargs else "positional", "annotation": segment(argument.annotation), "default": segment(default)})
                for argument, kind in [(node.args.vararg, "vararg"), *[(a, "keyword-only") for a in node.args.kwonlyargs], (node.args.kwarg, "kwarg")]:
                    if argument is not None:
                        default = node.args.kw_defaults[node.args.kwonlyargs.index(argument)] if kind == "keyword-only" else None
                        parameters.append({"name": argument.arg, "kind": kind, "annotation": segment(argument.annotation), "default": segment(default)})
                kind = "method" if result["structures"][scopes[-1]]["kind"] == "class" else "function"
                signature = ("async " if isinstance(node, ast.AsyncFunctionDef) else "") + "def " + node.name + "(" + ast.unparse(node.args) + ")" + (" -> " + ast.unparse(node.returns) if node.returns else "")
                index = add(kind, node, node.name, name_span(node, node.name), parameters=parameters, returns=segment(node.returns), signature=signature[:2000], signature_truncated=len(signature) > 2000,
                            asynchronous=isinstance(node, ast.AsyncFunctionDef), decorators=[segment(d) for d in node.decorator_list])
                scopes.append(index)
                for argument in [*positional, node.args.vararg, *node.args.kwonlyargs, node.args.kwarg]:
                    if argument is not None:
                        r = span(argument); r[2] = r[0]; r[3] = r[1] + len(argument.arg.encode("utf-8"))
                        add("parameter", argument, argument.arg, r, annotation=segment(argument.annotation))
                self.generic_visit(node)
                scopes.pop()

            visit_FunctionDef = function
            visit_AsyncFunctionDef = function

            def visit_ClassDef(self, node):
                index = add("class", node, node.name, name_span(node, node.name), bases=[segment(b) for b in node.bases], decorators=[segment(d) for d in node.decorator_list])
                scopes.append(index); self.generic_visit(node); scopes.pop()

            def visit_Lambda(self, node):
                index = add("function", node, parameters=[{"name": a.arg, "annotation": None} for a in node.args.args], returns=None, signature=None)
                scopes.append(index); self.generic_visit(node); scopes.pop()

            def visit_Assign(self, node):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        add("variable", node, target.id, span(target), annotation=None)
                self.generic_visit(node)

            def visit_AnnAssign(self, node):
                if isinstance(node.target, ast.Name):
                    add("variable", node, node.target.id, span(node.target), annotation=segment(node.annotation))
                self.generic_visit(node)

            def visit_Import(self, node):
                result["imports"].append({"file_id": file_id, "parser": parser, "position_encoding": "UTF8CodeUnitOffsetFromLineStart", "range": span(node), "enclosing_index": scopes[-1],
                                          "module": None, "relative_level": 0, "names": [{"name": a.name, "alias": a.asname} for a in node.names]})

            def visit_ImportFrom(self, node):
                result["imports"].append({"file_id": file_id, "parser": parser, "position_encoding": "UTF8CodeUnitOffsetFromLineStart", "range": span(node), "enclosing_index": scopes[-1],
                                          "module": node.module, "relative_level": node.level, "names": [{"name": a.name, "alias": a.asname} for a in node.names]})

            def visit_Call(self, node):
                callee = node.func
                name = callee.id if isinstance(callee, ast.Name) else callee.attr if isinstance(callee, ast.Attribute) else None
                r = span(callee)
                if isinstance(callee, ast.Attribute):
                    r = [r[2], r[3] - len(name.encode("utf-8")), r[2], r[3]]
                result["calls"].append({"file_id": file_id, "parser": parser, "position_encoding": "UTF8CodeUnitOffsetFromLineStart", "range": span(node),
                                        "callee_range": r if name else None, "callee_name": name, "callee_expression": segment(callee),
                                        "enclosing_index": scopes[-1], "argument_count": len(node.args) + len(node.keywords)})
                result["calls"][-1]["argument_shape"] = {"positional": len(node.args), "keywords": [k.arg for k in node.keywords if k.arg], "expansion": any(isinstance(a, ast.Starred) for a in node.args) or any(k.arg is None for k in node.keywords)}
                self.generic_visit(node)

        Visitor().visit(tree)
        result["files"].append({"file_id": file_id, "parser": parser, "status": "parsed"})
    except (SyntaxError, UnicodeError, ValueError, RecursionError) as error:
        result["files"].append({"file_id": file_id, "parser": parser, "status": "failed"})
        result["diagnostics"].append({"file_id": file_id, "parser": parser, "message": str(error), "line": getattr(error, "lineno", None)})

json.dump(result, sys.stdout, ensure_ascii=True)

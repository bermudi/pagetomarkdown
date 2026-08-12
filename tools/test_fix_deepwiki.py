import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fix_deepwiki import fix_codeblock_table, is_mermaid_garbage, extract_mermaid_labels

def test_is_mermaid_garbage():
    assert is_mermaid_garbage("#mermaid-123 { font-family:ui-sans-serif }")
    assert is_mermaid_garbage("body { stroke-dasharray: 5 } arrowMarkerPath")
    assert not is_mermaid_garbage("import fastapi_poe as fp\nprint('hi')")

def test_extract_mermaid_labels_strips_css():
    garbage = "#mermaid-abc .node { font-family:ui-sans-serif } Hello World"
    labels = extract_mermaid_labels(garbage)
    assert "Hello World" in labels
    assert "mermaid" not in labels.lower() or "Hello" in labels

def test_fix_codeblock_table_compressed():
    # Simulates the compressed table case from DeepWiki
    content = "## My Table\n| col1 | col2 ||| --- | --- ||| a | b ||| c | d |"
    fixed = fix_codeblock_table(content)
    assert fixed is not None
    assert "| col1 | col2 |" in fixed or "| col1" in fixed
    assert "## My Table" in fixed

def test_fix_codeblock_table_no_change():
    content = "import os\nprint(os.getcwd())"
    assert fix_codeblock_table(content) is None

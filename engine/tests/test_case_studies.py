from underscope.case_studies import build


def test_three_cases_render():
    text = build()
    assert text.count("## Case") == 3 and "PLACEHOLDER" in text

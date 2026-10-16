.PHONY: test bench royale-check play clean

test:
	uv run pytest -q

bench:
	uv run python bench/measure.py

royale-check:
	uv run python tests/js/make_golden.py
	node --test tests/js/*.test.mjs

play:
	python3 -m http.server 8000 --directory docs

clean:
	rm -rf .pytest_cache **/__pycache__

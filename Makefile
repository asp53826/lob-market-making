.PHONY: test bench clean

test:
	uv run pytest -q

bench:
	uv run python bench/measure.py

clean:
	rm -rf .pytest_cache **/__pycache__

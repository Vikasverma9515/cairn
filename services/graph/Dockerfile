# Pillar 9 of the plan: "everything should install in one go" — the
# whole engine (graph indexer, MCP server, semantic search, orchestrator,
# memory, analytics) in one image, with the one piece that needs network
# access (the embedding model's weights) baked in at build time so a
# fresh container never has to reach the internet to index a customer's
# code. The customer's source is mounted in, never copied in — nothing
# about their codebase becomes part of this image.
FROM python:3.12-slim AS base

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

# Editable-less install: this is a runtime image, not a dev checkout.
RUN pip install --no-cache-dir .

# Bake the embedding model weights into the image now, at build time —
# the one network call this whole service ever needs, made once, here,
# not on every fresh container's first `vectorize` call against a
# customer's air-gapped machine.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')"

# /workspace: the customer's codebase, mounted read-write (apply_edit /
# create_file / delete_file / run_command all need to write here).
# /data: this service's own state — the structure graph, the vector
# index, and per-customer memory — kept outside /workspace so it
# survives a container restart independent of the mounted repo.
VOLUME ["/workspace", "/data"]

ENTRYPOINT ["cairn-graph-mcp"]
CMD ["/workspace", "--db", "/data/graph.db", "--vectors", "/data/vectors", "--memory-db", "/data/memory.db", "--mode", "review"]

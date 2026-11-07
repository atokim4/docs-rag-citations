# Eval results (2026-11-07)

Corpus: Hono docs, 91 Markdown files, 854 chunks.
Questions: 24 answerable, 6 not covered by the docs.

## Retrieval (answerable questions, gold = chunk of the right file that contains the evidence phrase)

| Mode | hit@1 | hit@5 | MRR@10 |
| --- | --- | --- | --- |
| vector | 38% | 63% | 0.509 |
| fulltext | 21% | 71% | 0.411 |
| hybrid | 50% | 83% | 0.632 |

## Similarity gate (best cosine among the top 5 hybrid hits)

Answerable: min 0.437, median 0.61, max 0.834.
Not covered: min 0.163, median 0.387, max 0.525.

| Threshold | answerable kept | not-covered refused |
| --- | --- | --- |
| 0.2 | 24/24 | 1/6 |
| 0.25 | 24/24 | 1/6 |
| 0.3 | 24/24 | 2/6 |
| 0.35 | 24/24 | 3/6 |
| 0.4 (default) | 24/24 | 4/6 |
| 0.45 | 23/24 | 4/6 |

## End to end: ask() with hybrid search, top 5, extractive answerer

| Metric | Result |
| --- | --- |
| Not-covered questions refused | 6/6 |
| Answerable questions wrongly refused | 5/24 |
| Answers citing the gold chunk | 12/24 |
| Answers citing the right document | 17/24 |
| Refusal accuracy (all questions) | 83% |

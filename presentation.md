---
marp: true
title: De-Autoresearch
theme: uncover
paginate: true
style: |
  section {
    background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
    color: #0f172a;
    font-family: "Aptos", "Inter", "Helvetica Neue", Arial, sans-serif;
    padding: 64px 72px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-start;
    text-align: left;
  }
  h1 {
    color: #111827;
    letter-spacing: -0.03em;
    margin-bottom: 0.15em;
  }
  h2 {
    color: #334155;
    font-weight: 600;
    margin-top: 0;
  }
  strong, em {
    color: #0f172a;
  }
  ul {
    margin-top: 0.3em;
    padding-left: 1.25em;
  }
  ol {
    margin-top: 0.3em;
    padding-left: 1.4em;
  }
  li {
    margin: 0.22em 0;
    padding-left: 0.12em;
  }
  li > p {
    margin: 0;
  }
  li::marker {
    color: #4f46e5;
  }
  code {
    background: rgba(79, 70, 229, 0.08);
    color: #312e81;
    border-radius: 8px;
    padding: 0.1em 0.35em;
  }
  img {
    border-radius: 20px;
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
    width: 100%;
    max-width: 1320px;
    height: auto;
    max-height: 70vh;
    object-fit: contain;
    display: block;
    margin: 20px 0 0;
  }
  section > * {
    max-width: 1180px;
  }
  section > h1 {
    max-width: 1180px;
  }
  section > p, section > ul, section > ol, section > pre {
    max-width: 980px;
  }
---

# De-Autoresearch
## Community-driven autoresearch

Decentralized research direction for anonymous machine learning.

---

# Vision

Research should not be controlled by a single operator.

It should be:

- community-directed
- transparent
- reproducible
- open to iteration

---

# What It Does

De-Autoresearch creates a public research loop:

- community proposes directions
- on-chain contract records proposal and progress
- autoresearch executes the selected direction
- progress is written back on-chain

---

# Technical Core

- Filecoin stores proposal and run artifacts
- FVM smart contract manages proposal, vote, and progress state
- autoresearch reads the selected direction and trains
- progress snapshots are anchored on-chain

---

# Let's Demo

- submit a proposal
- let the community direct the next run
- watch autoresearch execute the selected direction
- see progress anchored on-chain

---

# Wrap-up

De-Autoresearch turns autoresearch into a public research loop.

- community steers the direction
- Filecoin stores the artifacts
- FVM records the proof of progress

The result is an open, anonymous, and iterative research system.

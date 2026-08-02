# Changelog

## [0.2.0](https://github.com/stayintempo/stamp/compare/v0.1.0...v0.2.0) (2026-08-02)


### Features

* accept owner/repo/path@ref and surface the pinned ref at start ([#23](https://github.com/stayintempo/stamp/issues/23)) ([d3b1b7d](https://github.com/stayintempo/stamp/commit/d3b1b7d6d25f1abf24204e4c27d4c2fd29889453)), closes [#19](https://github.com/stayintempo/stamp/issues/19)
* reduced mode with coverage-ledger auto-skips ([#28](https://github.com/stayintempo/stamp/issues/28)) ([0bf867d](https://github.com/stayintempo/stamp/commit/0bf867d7e3fbff70746d877447e80875532ccf71))
* stable step ids from trailing comments ([#27](https://github.com/stayintempo/stamp/issues/27)) ([ec1f94c](https://github.com/stayintempo/stamp/commit/ec1f94c5ae8a335d760779fd8bf12f1ea26a1b97)), closes [#26](https://github.com/stayintempo/stamp/issues/26)


### Bug Fixes

* join reduced-mode ledger IDs by stripped namespace and unbreak the checkbox row ([#30](https://github.com/stayintempo/stamp/issues/30)) ([fe75a1a](https://github.com/stayintempo/stamp/commit/fe75a1aea0fa433532967657da6cf2af7ee34048))
* parse the per-box ledger by header name and gate CI rows on role ([#35](https://github.com/stayintempo/stamp/issues/35)) ([e7cce4f](https://github.com/stayintempo/stamp/commit/e7cce4fe1c99c234c9ba3d76a0687edba1a69fb4))
* use the themed card background for overlay panels ([#29](https://github.com/stayintempo/stamp/issues/29)) ([b945494](https://github.com/stayintempo/stamp/commit/b9454946aa3d440f770db3a18b5de568f16ba91f))

## 0.1.0 (2026-07-23)


### Features

* **app:** resilient sync, validated resume, in-run settings, and finish UX ([22450ed](https://github.com/stayintempo/stamp/commit/22450ed1fd1b0e0e6a608c8ad1f27f0c8bf6b101))
* GitHub client, link rewriting, and markdown rendering ([74f1f6e](https://github.com/stayintempo/stamp/commit/74f1f6e131de07156b173410724a71c58424269e))
* **github:** paginate listStampIssues and support a doc-match filter ([656b82a](https://github.com/stayintempo/stamp/commit/656b82a657f463832393d8b57e33100f1b7779da))
* line-oriented checklist parser to RunDoc model ([8f5db1f](https://github.com/stayintempo/stamp/commit/8f5db1fdb029abc778811e1ca4cf3e5da309fe09))
* narrow-window run UI (setup, phase nav, step card, finish) ([dbefba1](https://github.com/stayintempo/stamp/commit/dbefba15ad035eb49708e14b8be8369e40dce3fd))
* reusable named tabs and a step-focused run screen ([afea7b0](https://github.com/stayintempo/stamp/commit/afea7b0e9bd53bb55f460a024c1c313914ab771c))
* run state, issue-body sync, and persistence ([1b0be38](https://github.com/stayintempo/stamp/commit/1b0be380539dd1c0d23fe1d154aa356ad4c3994b))
* **run:** surface phase and group intro prose during the run ([6cec4a8](https://github.com/stayintempo/stamp/commit/6cec4a8e2d1d5d8efc519d83e7f1767dba32edde))
* **ui:** staging/prod channel marker in footer ([19dd421](https://github.com/stayintempo/stamp/commit/19dd42109fd442516ff84fcbf9d7a9a668858d1d))


### Bug Fixes

* classify pre-step prose after the first heading as intro, not separator ([#16](https://github.com/stayintempo/stamp/issues/16)) ([2b4df17](https://github.com/stayintempo/stamp/commit/2b4df176a530dd4edba459896e2ff59a13c9f92c))
* keep separator prose inside the column, and use a wide window ([4cdec47](https://github.com/stayintempo/stamp/commit/4cdec4731594c584fd57e823cab565b6db88ff69))
* **keys:** route keyboard verdicts through StepCard so fail opens the note dialog ([0c8d902](https://github.com/stayintempo/stamp/commit/0c8d9026637d93e297d42e25ee36f5f5c5c910a7))
* **links:** match app host by host:port and treat protocol-relative hrefs as absolute ([b96e8f9](https://github.com/stayintempo/stamp/commit/b96e8f9e5198efd0522c48743070d9ea5f804c66))
* **parse:** fence info-string closers, trailing content, and numeric-prefix detection ([3cc2c54](https://github.com/stayintempo/stamp/commit/3cc2c54d291e0b905fcc6f47037f1d90112844b7))
* **security:** strip doc-controlled target/rel and rewrite links on every surface ([8995744](https://github.com/stayintempo/stamp/commit/8995744af12f44ceb499281df751589241de329c))
* **state:** CRLF-safe, label-anchored, fence-aware issue-body sync ([c9cd57c](https://github.com/stayintempo/stamp/commit/c9cd57c6819dd18c22957fe8316cf06ef28737e8))


### Miscellaneous Chores

* pin first release version ([2a5b7d3](https://github.com/stayintempo/stamp/commit/2a5b7d382edbc2723991c9d34e8e7f6883f1e4ba))

# Changelog

## [1.2.0](https://github.com/P4suta/public-phonebook/compare/ios-v1.1.0...ios-v1.2.0) (2026-11-22)


### Features

* **ios:** use native search and calling controls ([#446](https://github.com/P4suta/public-phonebook/issues/446)) ([d78fbe3](https://github.com/P4suta/public-phonebook/commit/d78fbe39c7192cd0cb6cbc42b1ec8e7377e37e55))


### Bug Fixes

* **ci:** use preinstalled Xcode simulator runtimes ([#412](https://github.com/P4suta/public-phonebook/issues/412)) ([291080d](https://github.com/P4suta/public-phonebook/commit/291080d53af7199fd3fb467529dce1c847e9b20e))
* **ci:** verify staged sources and compatible simulators ([#405](https://github.com/P4suta/public-phonebook/issues/405)) ([20a86a9](https://github.com/P4suta/public-phonebook/commit/20a86a9ba43c54e3e232fac38f0a1140219e7c40))
* **copy:** use plain Japanese across the product ([#421](https://github.com/P4suta/public-phonebook/issues/421)) ([0ae0dd9](https://github.com/P4suta/public-phonebook/commit/0ae0dd9c24887ef28f02a419ca2eab1bf337bbbb))
* **images:** use a fictional city for product screenshots ([#422](https://github.com/P4suta/public-phonebook/issues/422)) ([5cdb604](https://github.com/P4suta/public-phonebook/commit/5cdb604f91383c39f38385b644ab4dbd6f9efb9d))
* **ios:** keep inactive navigation paths empty ([#432](https://github.com/P4suta/public-phonebook/issues/432)) ([84bad3f](https://github.com/P4suta/public-phonebook/commit/84bad3f472c0ae7173623f9c0cf8865aac7c57da))
* **ios:** keep search reachable after scrolling ([#420](https://github.com/P4suta/public-phonebook/issues/420)) ([3a846ea](https://github.com/P4suta/public-phonebook/commit/3a846ea9863f5959d3f2c103c5c7246328ed88e7))
* **ios:** preserve cancellation results during task completion ([#434](https://github.com/P4suta/public-phonebook/issues/434)) ([2b5aed8](https://github.com/P4suta/public-phonebook/commit/2b5aed8d329842bb46a9f4d118671405448b8a62))
* **ios:** restore native navigation across window sizes ([#430](https://github.com/P4suta/public-phonebook/issues/430)) ([46c7015](https://github.com/P4suta/public-phonebook/commit/46c70157010e908e828ec702d40dec7286b88bb7))
* **ios:** stabilize navigation and release verification ([#437](https://github.com/P4suta/public-phonebook/issues/437)) ([98da510](https://github.com/P4suta/public-phonebook/commit/98da5102316b1f9d42b55cfa558ffaa0612cfa30))
* **ui:** align controls and keep search beside details ([#417](https://github.com/P4suta/public-phonebook/issues/417)) ([5cacb46](https://github.com/P4suta/public-phonebook/commit/5cacb46a6d5b6e091440ea8f4f62113abae60102))
* **web:** preserve existing Cloudflare domain connections ([#408](https://github.com/P4suta/public-phonebook/issues/408)) ([6101207](https://github.com/P4suta/public-phonebook/commit/6101207998b00f75d37be0fe7c8b3d90e5bb6d48))
* **web:** restore search text before the index loads ([#415](https://github.com/P4suta/public-phonebook/issues/415)) ([b68201d](https://github.com/P4suta/public-phonebook/commit/b68201d9e39ce0e3558c9d36b1aeabea1d92280e))

## [1.1.0](https://github.com/P4suta/public-phonebook/compare/ios-v1.0.0...ios-v1.1.0) (2026-11-09)


### Features

* **data:** expand official public directory coverage ([#384](https://github.com/P4suta/public-phonebook/issues/384)) ([3f2a21e](https://github.com/P4suta/public-phonebook/commit/3f2a21e5335cdaa6c8375547789af55b6b1cb6ed))
* explain caller identification and open source access ([#391](https://github.com/P4suta/public-phonebook/issues/391)) ([01f3162](https://github.com/P4suta/public-phonebook/commit/01f31625fdbaa08e31cae6e85e89c7059031fcce))
* **search:** align literal search and verified readings across apps ([#385](https://github.com/P4suta/public-phonebook/issues/385)) ([d92ed3d](https://github.com/P4suta/public-phonebook/commit/d92ed3d01a01df4a7caeb0ab67ceff3f343f69a2))


### Bug Fixes

* **ios:** bound caller loading and retire experimental search ([#362](https://github.com/P4suta/public-phonebook/issues/362)) ([64fbb79](https://github.com/P4suta/public-phonebook/commit/64fbb79e8507fc0d4239fc99b79b91525f59725b))
* **ios:** derive bundle versions from build settings ([#367](https://github.com/P4suta/public-phonebook/issues/367)) ([22a18d7](https://github.com/P4suta/public-phonebook/commit/22a18d7a4796496bfd8d710ab35f4f28e8f97574))
* **ios:** derive the SBOM library components from the linked package targets ([#350](https://github.com/P4suta/public-phonebook/issues/350)) ([2ca4f5e](https://github.com/P4suta/public-phonebook/commit/2ca4f5ef2a235c7b852b3a2615fe97be03e48250))
* **ios:** isolate diagnostics and verify bounded caller reloads ([#388](https://github.com/P4suta/public-phonebook/issues/388)) ([d171932](https://github.com/P4suta/public-phonebook/commit/d171932dd98a1ba1c807527b7c36ae27ae897feb))
* **ios:** preserve App Group requests before signing ([#370](https://github.com/P4suta/public-phonebook/issues/370)) ([eb70fba](https://github.com/P4suta/public-phonebook/commit/eb70fbada59a37e4c3b2d703add5de40a6f62b33))
* **ios:** preserve bundle versions during generation ([#368](https://github.com/P4suta/public-phonebook/issues/368)) ([9614006](https://github.com/P4suta/public-phonebook/commit/9614006032673a88000f3cda07fe9bf5010bebae))
* **privacy:** stop retaining Worker request diagnostics ([#372](https://github.com/P4suta/public-phonebook/issues/372)) ([1a501c5](https://github.com/P4suta/public-phonebook/commit/1a501c5cd5e6ebfbadbfe4e275e735239f44ddc4))


### Performance Improvements

* **web:** bound local search storage and preserve private navigation ([#387](https://github.com/P4suta/public-phonebook/issues/387)) ([f344deb](https://github.com/P4suta/public-phonebook/commit/f344debd31c9dc29765724a3335b1dd9eaaa2931))

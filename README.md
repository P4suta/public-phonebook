# Public Phonebook

A searchable public contact directory covering all 47 prefectures of Japan.

## Installation

```sh
mise install
mise x -- npm ci
mise x -- cargo build --locked
```

## Usage

```sh
curl --fail-with-body --get --data-urlencode 'q=横浜市役所' https://dial.page/api/contacts
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE-APACHE) or the [Massachusetts Institute of Technology (MIT) license](LICENSE-MIT), at your option.

Contributions use both licenses unless you state other terms.

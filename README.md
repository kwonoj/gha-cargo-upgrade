### Example

```yml
name: Bump up swc_core

on:
  schedule:
    # Twice a day, one for 12:00 and one for 6:00am
    - cron: '0 0 * * *'
    - cron: '0 6 * * *'

jobs:
  upgrade-package:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v2
      with:
        submodules: true

    - uses: actions/cache@v3
      with:
        path: |
          ~/.cargo/bin/
        key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}

    - name: Install Rust
      uses: actions-rs/toolchain@v1
      with:
        profile: minimal
        override: true

    - uses: Swatinem/rust-cache@v2
      with:
        shared-key: "gha-cargo-upgrade"
        cache-on-failure: true

    - name: Run cargo upgrade
      uses: kwonoj/gha-cargo-upgrade@read-config
      with:
        # Required, gh token for creating pull request
        # This should be a personal token with repo access if you'd like to run CI actions.
        # using default GITHUB_TOKEN will create PR with github-actions bot user, and it'll skip any CI actions.
        # https://github.com/peter-evans/create-pull-request/issues/48
        token: ${{ secrets.REPO_SCOPED_TOKEN }}
        # Required, packages to upgrade. "*" indicates upgrade all
        packages: "swc_core"
        # Optional, Custom branch name for the pull request
        branch_name: "some_branch_name"
        # Optional, user to @-mention when pull request is created
        notified_users: "kwonoj,everylogbot"
        # Optional, run cargo upgrade with --incompatible
        incompatible: false
```
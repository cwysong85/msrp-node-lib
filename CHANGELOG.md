# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Host advertising configuration** - Separate bind and advertise addresses for NAT/cloud deployments
- Comprehensive GitHub Actions CI/CD pipeline
- Multi-platform testing (Ubuntu, Windows, macOS)
- Multi-Node.js version testing (18.x, 20.x, 22.x)
- Advanced multi-process testing infrastructure
- Automated dependency updates
- Security audit workflow
- Test coverage reporting with Codecov
- GitHub issue and PR templates
- Contributing guidelines
- Professional README with badges

### Enhanced

- Multi-process functional testing with real network communication
- Advanced test scenarios for load testing and error handling
- Improved test cleanup and resource management
- Better documentation and examples

### Fixed

- Port management and cleanup in functional tests
- Process synchronization in multi-process tests
- Resource leaks in test infrastructure

## [0.1.5] - 2024-XX-XX

### Added

- Initial release with core MSRP functionality
- RFC 4975 protocol implementation
- SDP integration
- Session management
- Message sending and receiving
- Connection handling
- Comprehensive unit test suite

### Features

- MSRP server and client functionality
- Session controller for managing multiple sessions
- SDP offer/answer mechanism
- Message chunking support
- Connection timeout handling
- Event-driven architecture
- Configurable logging

### Supported Platforms

- Node.js 18.x, 20.x, 22.x
- Windows, macOS, Linux
- Cross-platform compatibility

---

## Contributing to the Changelog

When contributing to this project, please add your changes to the `[Unreleased]` section using the following categories:

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for vulnerability fixes

Example:

```markdown
### Added

- New MSRP extension support for file transfer

### Fixed

- Connection timeout not being respected in certain scenarios
```

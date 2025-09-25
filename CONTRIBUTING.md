# Contributing to MSRP Node.js Library

Thank you for your interest in contributing to the MSRP Node.js Library! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites

- Node.js 18.x or higher
- npm or yarn
- Git

### Development Setup

1. **Fork and Clone**

   ```bash
   git clone https://github.com/YOUR_USERNAME/msrp-node-lib.git
   cd msrp-node-lib
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Verify Setup**
   ```bash
   npm run test:all
   ```

## 📝 Development Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `test/description` - Test improvements
- `chore/description` - Maintenance tasks

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat(parser): add support for chunked messages
fix(session): resolve connection timeout issues
docs(readme): update installation instructions
test(functional): add multi-process test scenarios
```

### Types:

- `feat` - New features
- `fix` - Bug fixes
- `docs` - Documentation changes
- `test` - Test additions/modifications
- `refactor` - Code refactoring
- `perf` - Performance improvements
- `chore` - Maintenance tasks

## 🧪 Testing Requirements

### Test Coverage

- All new code must include tests
- Unit test coverage should remain above 90%
- Functional tests should cover new features
- Multi-process tests for network functionality

### Running Tests

```bash
# Run all tests
npm run test:all

# Run specific test suites
npm run test                 # Unit tests
npm run test:functional      # Functional tests
npm run test:coverage        # Coverage report

# Run tests in watch mode
npm run test:watch
npm run test:functional:watch
```

### Test Categories

1. **Unit Tests** (`tests/`)

   - Individual module testing
   - Mock external dependencies
   - Fast execution
   - High coverage

2. **Functional Tests** (`tests/functional/`)

   - End-to-end scenarios
   - Real MSRP communication
   - Integration testing
   - Multi-process scenarios

3. **Multi-Process Tests**
   - Separate Node.js processes
   - Real network communication
   - Complex scenarios
   - Load testing

## 🏗️ Code Style

### JavaScript Style

- Use ES6+ features where appropriate
- Follow existing code patterns
- Use meaningful variable names
- Add JSDoc comments for public APIs

### Example:

```javascript
/**
 * Creates a new MSRP session
 * @param {Object} config - Session configuration
 * @param {string} config.sessionId - Unique session identifier
 * @returns {Session} The created session instance
 */
function createSession(config) {
  // Implementation
}
```

## 📚 Documentation

### README Updates

- Update README.md for new features
- Include code examples
- Update configuration tables
- Add new badges if applicable

### API Documentation

- Document all public methods
- Include parameter types and descriptions
- Provide usage examples
- Document error conditions

## 🔄 Pull Request Process

### Before Submitting

1. **Ensure all tests pass**

   ```bash
   npm run test:all
   ```

2. **Check code style**

   ```bash
   npm run lint --if-present
   ```

3. **Update documentation**

   - Update README if needed
   - Add JSDoc comments
   - Update configuration tables

4. **Add tests**
   - Unit tests for new functionality
   - Functional tests for features
   - Multi-process tests for network features

### PR Checklist

- [ ] Tests pass on all platforms
- [ ] Code coverage maintained/improved
- [ ] Documentation updated
- [ ] Breaking changes documented
- [ ] Related issues referenced

### Review Process

1. Automated CI/CD checks must pass
2. Code review by maintainers
3. Functional testing verification
4. Documentation review
5. Final approval and merge

## 🐛 Bug Reports

### Before Reporting

1. Check existing issues
2. Test with latest version
3. Create minimal reproduction case

### Bug Report Template

- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment information
- Code examples
- Error messages

## 💡 Feature Requests

### Before Requesting

1. Check existing issues and PRs
2. Consider if it fits the library's scope
3. Think about backward compatibility

### Feature Request Template

- Problem description
- Proposed solution
- Use cases and examples
- Compatibility considerations
- Implementation suggestions

## 🏷️ Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):

- `MAJOR.MINOR.PATCH`
- Breaking changes increment MAJOR
- New features increment MINOR
- Bug fixes increment PATCH

### Release Workflow

1. Create release branch
2. Update version in package.json
3. Update CHANGELOG.md
4. Create GitHub release
5. Automated publishing to npm

## 📞 Getting Help

### Community

- GitHub Issues - Bug reports and feature requests
- GitHub Discussions - General questions and ideas

### Maintainers

- @cwysong85 - Primary maintainer

## 🙏 Recognition

Contributors will be recognized in:

- CHANGELOG.md for their contributions
- GitHub contributors page
- Release notes for significant contributions

## 📄 License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to the MSRP Node.js Library! 🎉

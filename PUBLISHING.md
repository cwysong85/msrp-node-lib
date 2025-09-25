# Publishing and Release Workflow

This document explains the proper workflow for publishing releases of the MSRP Node.js Library.

## 🔒 Security First: Branch Protection

### Recommended GitHub Branch Protection Rules

For the `main` branch, enable these protections in GitHub Settings → Branches:

- ✅ **Require pull request reviews before merging**
- ✅ **Require status checks to pass before merging**
  - Require branches to be up to date before merging
  - Required status checks: `test`, `test-windows`, `test-macos`, `security-audit`
- ✅ **Restrict pushes that create files over 100MB**
- ✅ **Require signed commits** (recommended)
- ✅ **Include administrators** (apply rules to admins too)

This prevents accidental direct pushes to main and ensures all code goes through CI/CD.

## 📦 Publishing Workflows

### 1. **Automatic Publishing (Recommended)**

**Trigger**: Creating a GitHub Release
**Workflow**: `.github/workflows/release.yml`

```bash
# Steps to publish:
1. Ensure all changes are merged to main branch
2. Update version in package.json: npm version patch|minor|major
3. Update CHANGELOG.md with release notes
4. Push version commit: git push && git push --tags
5. Create GitHub Release using the new tag
6. Publishing happens automatically via GitHub Actions
```

### 2. **Manual Publishing (Emergency Only)**

**Trigger**: Manual workflow dispatch
**Workflow**: `.github/workflows/manual-publish.yml`

```bash
# Emergency publishing from GitHub Actions:
1. Go to Actions → Manual Publish
2. Click "Run workflow"
3. Choose NPM tag (latest, beta, alpha, next)
4. Optionally run in dry-run mode first
5. Confirm and run
```

### 3. **What About CI/CD Pipeline?**

**Trigger**: All pushes and PRs
**Workflow**: `.github/workflows/ci.yml`

**Purpose**: Testing only - NO publishing!

- ✅ Runs tests on all platforms
- ✅ Generates coverage reports
- ✅ Runs security audits
- ❌ Does NOT publish to NPM (this was removed for security)

## 🚫 What We Fixed

### Before (Insecure):

```yaml
# BAD: Auto-published on every main branch push
if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

### After (Secure):

```yaml
# GOOD: Only publishes on manual GitHub Releases
on:
  release:
    types: [published]
```

## 🔄 Development Workflow

### For Contributors:

```bash
# 1. Create feature branch
git checkout -b feature/my-feature

# 2. Make changes and test
npm run test:all

# 3. Commit and push
git commit -m "feat: add amazing feature"
git push origin feature/my-feature

# 4. Create Pull Request
# CI/CD will run automatically - tests must pass!

# 5. After review and merge to main
# Maintainers can then create a release
```

### For Maintainers:

```bash
# 1. After PRs are merged to main
git checkout main && git pull

# 2. Update version
npm version patch  # or minor/major

# 3. Update changelog
# Edit CHANGELOG.md with new features/fixes

# 4. Push version update
git push && git push --tags

# 5. Create GitHub Release
# Use the new tag, add release notes
# Publishing happens automatically!
```

## 📊 CI/CD Pipeline Overview

### On Pull Requests & Pushes:

- **Multi-Platform Testing** (Ubuntu, Windows, macOS)
- **Multi-Node Testing** (18.x, 20.x, 22.x)
- **Unit & Functional Tests**
- **Security Auditing**
- **Coverage Reporting**
- **Dependency Checking**

### On GitHub Releases:

- **All above tests PLUS**
- **NPM Publishing**
- **GitHub Packages Publishing**
- **Release Notes**

### Weekly Automated:

- **Dependency Updates**
- **Security Patch PRs**

## 🛡️ Security Benefits

1. **No Accidental Publishing** - Can't accidentally publish by pushing to main
2. **Required Reviews** - All code must be reviewed before main
3. **Comprehensive Testing** - All tests must pass before merge
4. **Audit Trail** - Clear history of what was published when
5. **Rollback Capability** - Can easily see what changed between versions

## 🎯 Best Practices

- **Never push directly to main** - Always use Pull Requests
- **Test thoroughly** - Run `npm run test:all` before creating PRs
- **Update documentation** - Keep README and CHANGELOG current
- **Semantic versioning** - Use appropriate version bumps
- **Release notes** - Write clear, helpful release descriptions
- **Security first** - Let CI/CD handle publishing, not manual `npm publish`

---

This workflow ensures that:

- ✅ Only tested, reviewed code gets published
- ✅ Publishing is intentional and controlled
- ✅ All releases are properly documented
- ✅ Security vulnerabilities are caught early
- ✅ Contributors can safely work without breaking production

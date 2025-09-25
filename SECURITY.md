# Security Policy

## Supported Versions

We actively support the following versions of the MSRP Node.js Library:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security vulnerability in this project, please report it responsibly.

### How to Report

1. **Do NOT create a public GitHub issue** for security vulnerabilities
2. **Email**: Send details to cwysong85@gmail.com with subject "Security Vulnerability - MSRP Node.js Library"
3. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment**: We'll acknowledge receipt within 48 hours
- **Assessment**: We'll assess the vulnerability within 5 business days
- **Updates**: We'll provide regular updates on our progress
- **Resolution**: We'll work to resolve critical vulnerabilities within 30 days
- **Credit**: We'll credit you in the security advisory (if desired)

### Security Best Practices

When using this library:

1. **Keep Updated**: Always use the latest version
2. **Dependencies**: Regularly update dependencies
3. **Network Security**: Use TLS/SSL in production
4. **Input Validation**: Validate all inputs to MSRP methods
5. **Access Control**: Implement proper access controls
6. **Monitoring**: Monitor for unusual network activity

### Security Features

This library includes:

- Input validation for MSRP messages
- Protection against malformed SDP
- Resource limits to prevent DoS
- Secure default configurations
- Comprehensive error handling

### Automated Security

We use:

- **Dependabot**: Automated dependency updates
- **npm audit**: Regular vulnerability scanning
- **GitHub Security Advisories**: Vulnerability tracking
- **CodeQL Analysis**: Static code analysis (if enabled)

## Disclosure Policy

- We follow responsible disclosure practices
- Security fixes are prioritized and released quickly
- Public disclosure occurs after fixes are available
- We maintain a security advisory for each vulnerability

Thank you for helping keep the MSRP Node.js Library secure! 🔒

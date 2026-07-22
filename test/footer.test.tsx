import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Footer } from '../src/components/Footer';

describe('Footer channel marker', () => {
  it('shows the version and no channel marker on prod', () => {
    const { container, queryByText } = render(<Footer version="1.2.3" channel="prod" />);
    expect(container.textContent).toContain('v1.2.3');
    expect(queryByText(/staging/)).toBeNull();
    expect(container.querySelector('.staging-tag')).toBeNull();
  });

  it('appends a distinct staging marker on the staging channel', () => {
    const { container } = render(<Footer version="1.2.3" channel="staging" />);
    const tag = container.querySelector('.staging-tag');
    expect(tag).toBeTruthy();
    expect(tag?.textContent).toContain('staging');
    // version is still present alongside the marker
    expect(container.textContent).toContain('v1.2.3');
  });

  it('defaults to the build-time channel (prod in tests) when no prop is given', () => {
    const { container } = render(<Footer version="9.9.9" />);
    expect(container.querySelector('.staging-tag')).toBeNull();
  });
});

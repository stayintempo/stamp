// App footer: brand + version, with a distinct "staging" marker on the staging
// channel. Props default to the build-time globals; passing them explicitly
// keeps the channel marker unit-testable without recompiling.

interface Props {
  version?: string;
  channel?: string;
}

export function Footer({ version = __APP_VERSION__, channel = __APP_CHANNEL__ }: Props) {
  const staging = channel === 'staging';
  return (
    <footer class="appfoot">
      <span class="brand">STAMP</span>
      <span>
        v{version}
        {staging && <span class="staging-tag"> · staging</span>}
      </span>
    </footer>
  );
}

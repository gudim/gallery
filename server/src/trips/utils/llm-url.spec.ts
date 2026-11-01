import { isInternalAddress, llmUrlRefusal } from 'src/trips/utils/llm-url.js';

describe(isInternalAddress.name, () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('refuses %s', (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '104.18.7.192', '2606:4700::6810:1'])('lets %s through', (address) => {
    expect(isInternalAddress(address)).toBe(false);
  });
});

describe(llmUrlRefusal.name, () => {
  it('lets a public server through', async () => {
    await expect(llmUrlRefusal('https://8.8.8.8/v1')).resolves.toBeNull();
  });

  it.each(['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]/v1', 'http://192.168.1.5/v1'])(
    'refuses %s inside the network',
    async (url) => {
      await expect(llmUrlRefusal(url)).resolves.toContain("inside the server's network");
    },
  );

  it('refuses what is not an http URL', async () => {
    await expect(llmUrlRefusal('file:///etc/passwd')).resolves.toContain('https://');
    await expect(llmUrlRefusal('api.openai.com')).resolves.toContain('not a URL');
  });
});

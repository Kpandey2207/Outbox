import { SMTPServer } from 'smtp-server';

/**
 * Offline stand-in for Ethereal: accepts any login and prints each message it receives.
 * Point the backend at it with SMTP_HOST=127.0.0.1 SMTP_PORT=2525. Dev only.
 */
const port = Number(process.env.DEV_SMTP_PORT ?? 2525);
let count = 0;

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth: (_auth, _session, cb) => cb(null, { user: 'dev' }),
  onData(stream, session, cb) {
    let size = 0;
    let head = '';
    const files: string[] = [];
    let tail = '';
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (head.length < 2000) head += chunk.toString();
      // Attachment names, from the MIME part headers anywhere in the message.
      const text = tail + chunk.toString('latin1');
      for (const m of text.matchAll(/Content-Disposition: attachment;\s*filename="?([^"\r\n;]+)/gi)) files.push(m[1]!);
      tail = text.slice(-300);
    });
    stream.on('end', () => {
      count++;
      const subject = /^Subject: (.*)$/im.exec(head)?.[1] ?? '';
      const messageId = /^Message-ID: (.*)$/im.exec(head)?.[1] ?? '';
      const from = /^From: (.*)$/im.exec(head)?.[1] ?? '';
      const to = session.envelope.rcptTo.map((r) => r.address).join(', ');
      const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
      console.log(
        `${new Date().toISOString()} #${count} to=${to} from=${from} envelope=${envelopeFrom} subject="${subject}" id=${messageId} bytes=${size}` +
          (files.length ? ` attachments=${[...new Set(files)].join('|')}` : ''),
      );
      cb();
    });
  },
});

server.listen(port, () => console.log(`dev SMTP listening on ${port}`));

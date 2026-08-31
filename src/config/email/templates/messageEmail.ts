import {
  dayfiEmailHeading,
  dayfiEmailLayout,
  dayfiEmailParagraph,
} from './layout';

export function buildMessageEmail(options: {
  subject: string;
  heading: string;
  paragraphs: string[];
  preheader?: string;
}) {
  const content = [
    dayfiEmailHeading(options.heading),
    ...options.paragraphs.map((p, i, arr) =>
      dayfiEmailParagraph(p, {
        muted: i > 0,
        marginBottom: i === arr.length - 1 ? 0 : 16,
      })
    ),
  ].join('');

  const html = dayfiEmailLayout({
    preheader: options.preheader ?? options.heading,
    content,
  });

  const text = [
    options.heading,
    '',
    ...options.paragraphs,
    '',
    '— Dayfi',
  ].join('\n');

  return { subject: options.subject, text, html };
}

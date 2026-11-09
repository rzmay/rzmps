import { docsUrl } from './site.mjs';
import { previewDefaults } from './preview-settings.mjs';
import { containers } from '../preview/media.mjs';

export function exampleSEO(example) {
  const settings = { ...previewDefaults, ...example.previewSettings };
  const canonical = new URL(`examples/${example.id}.html`, docsUrl).href;
  const asset = extension => new URL(`previews/${example.id}.${extension}`, docsUrl).href;
  return [
    ['link', { rel: 'canonical', href: canonical }],
    ['meta', { name: 'description', content: example.description }],
    ...Object.entries({ 'og:type': 'website', 'og:url': canonical, 'og:title': example.title,
      'og:description': example.description, 'og:image': asset('png'), 'og:image:alt': example.title,
      'og:video': asset(settings.format), 'og:video:secure_url': asset(settings.format),
      'og:video:type': containers[settings.format].mime,
      'og:video:width': String(settings.width), 'og:video:height': String(settings.height),
    }).map(([property, content]) => ['meta', { property, content }]),
    ...Object.entries({ 'twitter:card': 'summary_large_image', 'twitter:title': example.title,
      'twitter:description': example.description, 'twitter:image': asset('png'),
    }).map(([name, content]) => ['meta', { name, content }]),
  ];
}

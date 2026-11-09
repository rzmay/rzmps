import React, { useEffect, useRef, useState } from 'react';
import { filterExamples } from 'examples/utils/search.js';
import { examples } from 'examples/index.js';
import { ChevronLeft, Menu } from 'lucide-react';

// Top contributors from GitHub. Keep this curated list free of runtime API requests.
const CONTRIBUTORS = ['rzmay'];

export default function LandingLayout({ children, searchQuery = '', onSearchChange, onExampleSelect, selectedExample }) {
  const [open, setOpen] = useState(true);
  const toggleRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className={`landing-layout${open ? ' sidebar-open' : ''}`}>
      <button
        ref={toggleRef}
        type="button"
        className="sidebar-toggle"
        aria-controls="landing-sidebar"
        aria-expanded={open}
        aria-label={open ? 'Hide project information' : 'Show project information'}
        title={open ? 'Hide project information' : 'Show project information'}
        onClick={() => setOpen(value => !value)}
      >
        {open ? <ChevronLeft size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      <aside id="landing-sidebar" className="landing-sidebar" aria-label="About RZMPS" aria-hidden={!open} inert={!open}>
        <header>
          <h1 className="landing-heading">
            <a className="landing-brand" href="/" aria-label="RZMPS home">
              <span className="landing-logo" aria-hidden="true">🧅</span>
              <span>RZMPS</span>
            </a>
            <a className="landing-version" href="https://www.npmjs.com/package/@rzmps/rzmps" target="_blank" rel="noreferrer">
              v{import.meta.env.VITE_RZMPS_VERSION}
            </a>
          </h1>
          <p>A modular <a href="https://threejs.org/" target="_blank" rel="noreferrer">Three.js</a> particle system. Compose emitters, lifetime modules, spatial effects, renderers, and event-triggered subsystems using WebGL or WebGPU rendering.</p>
        </header>

        <section className="example-search" aria-label="Find examples">
          <h2>Examples</h2>
          <label htmlFor="example-search">Search examples and tags</label>
          <div>
            <input id="example-search" type="search" value={searchQuery}
              onChange={event => onSearchChange(event.target.value)} />
            {searchQuery && <button type="button" onClick={() => onSearchChange('')}>Clear</button>}
          </div>
          <ul>
            {filterExamples(examples, searchQuery).map(example => (
              <li key={example.id}><button type="button" aria-pressed={selectedExample === example.title}
                onClick={() => onExampleSelect(example.title)}>{example.title}</button></li>
            ))}
          </ul>
          {filterExamples(examples, searchQuery).length === 0 && <p role="status">No matching examples.</p>}
        </section>

        <nav aria-label="Project resources">
          <h2>Learn</h2>
          <a className="landing-start" href="/docs/guides/first-particle-system.html">Get started <span aria-hidden="true">↗</span></a>
          <a href="/docs/guides/">Guides</a>
          <a href="/docs/api/">API reference</a>
          <a href="/docs/examples/">Example walkthroughs</a>
          <h2>Code</h2>
          <a href="https://github.com/rzmay/rzmps" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
          <a href="https://www.npmjs.com/package/@rzmps/rzmps" target="_blank" rel="noreferrer">npm package <span aria-hidden="true">↗</span></a>
          <h2>Community</h2>
          <a href="/docs/contributing.html">Contribute</a>
          <a href="https://github.com/rzmay/rzmps/issues/new?template=project_submission.yml" target="_blank" rel="noreferrer">Share your project <span aria-hidden="true">↗</span></a>
        </nav>

        <footer className="landing-contributors">
          <h2>Made by the community</h2>
          <div className="landing-avatars">
            {CONTRIBUTORS.map(username => (
              <a key={username} href={`https://github.com/${username}`} target="_blank" rel="noreferrer" aria-label={`${username} on GitHub`} title={username}>
                <img src={`https://github.com/${username}.png?size=80`} alt={username} width="40" height="40" />
              </a>
            ))}
          </div>
          <a href="https://github.com/rzmay/rzmps/graphs/contributors" target="_blank" rel="noreferrer">All contributors <span aria-hidden="true">↗</span></a>
        </footer>
      </aside>
      {children}
    </div>
  );
}

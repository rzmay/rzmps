import PropTypes from 'prop-types';
import { useState } from 'react';
import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/react';
import { Search } from 'lucide-react';
import { examples } from 'examples/index.js';
import { filterExamples } from 'examples/utils/search.js';

/** Compact, keyboard-accessible discovery without a permanent results list. */
export default function ExampleSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const matches = filterExamples(examples, query);
  return (
    <div className="example-search">
      <Search size={17} aria-hidden="true" />
      <Combobox
        value={null}
        onClose={() => setQuery('')}
        onChange={example => {
          if (example) onSelect(example.title);
          setQuery('');
        }}
      >
        <ComboboxInput
          aria-label="Search examples and tags"
          placeholder="Search examples…"
          displayValue={() => query}
          onChange={event => setQuery(event.target.value)}
          autoComplete="off"
        />
        {query.trim() && (
          <ComboboxOptions anchor="bottom start" className="example-search-results" modal={false}>
            {matches.map(example => (
              <ComboboxOption key={example.id} value={example} className="example-search-option">
                <strong>{example.title}</strong>
                <span>{example.description}</span>
                <small>{example.tags.join(' · ')}</small>
              </ComboboxOption>
            ))}
            {!matches.length && <p role="status">No matching examples</p>}
          </ComboboxOptions>
        )}
      </Combobox>
    </div>
  );
}
ExampleSearch.propTypes = { onSelect: PropTypes.func.isRequired };

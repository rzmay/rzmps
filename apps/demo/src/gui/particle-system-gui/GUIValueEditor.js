import * as THREE from 'three';
import { AUDIO_BUFFER_SOURCE_KEY } from './constants';

export class GUIValueEditor {
    constructor(host) {
        this.host = host;
    }

    addTextureUpload(folder, label, onLoad) {
        this.addFileUpload(folder, label, 'image/*', async (file, url) => {
            const texture = await new THREE.TextureLoader().loadAsync(url);
            texture.name = file.name;
            onLoad(texture);
            this.host.rebuild();
            this.host.emitCode();
        });
    }

    addAudioUpload(folder, module, key, label) {
        const clips = module[key] ?? [];
        const info = {
            clips: clips.length
                ? clips.map((clip) => this.audioBufferLabel(clip)).join(', ')
                : '(none)',
        };

        folder.add(info, 'clips').name(label).disable();
        this.addFileUpload(folder, `Upload ${label}`, 'audio/*', async (files) => {
            const loader = new THREE.AudioLoader();
            const buffers = await Promise.all(files.map(async ({ file, url }) => {
                const buffer = await loader.loadAsync(url);
                return this.setAudioBufferSource(buffer, url, file.name);
            }));

            module[key] = buffers;
            this.host.rebuild();
            this.host.emitCode();
        }, true);
    }

    addFileUpload(folder, label, accept, onFile, multiple = false) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.hidden = true;
        document.body.appendChild(input);

        const handleFiles = async (files) => {
            if (files.length === 0) return;

            const uploads = files.map((file) => ({
                file,
                url: URL.createObjectURL(file),
            }));

            if (multiple) {
                await onFile(uploads);
            } else {
                await onFile(uploads[0].file, uploads[0].url);
            }
            input.value = '';
        };

        input.addEventListener('change', async () => {
            await handleFiles(Array.from(input.files ?? []));
        });

        const actions = {
            choose: () => input.click(),
        };
        const controller = folder.add(actions, 'choose').name(label);
        controller.domElement.classList.add('psgui-upload-controller');
        controller.domElement.title = 'Click to choose a file, or drag and drop one here.';
        controller.domElement.addEventListener('dragover', (event) => {
            event.preventDefault();
            controller.domElement.classList.add('psgui-upload-hover');
        });
        controller.domElement.addEventListener('dragleave', () => {
            controller.domElement.classList.remove('psgui-upload-hover');
        });
        controller.domElement.addEventListener('drop', async (event) => {
            event.preventDefault();
            controller.domElement.classList.remove('psgui-upload-hover');

            const files = Array.from(event.dataTransfer?.files ?? [])
                .filter((file) => this.fileMatchesAccept(file, accept));
            await handleFiles(multiple ? files : files.slice(0, 1));
        });

        return controller;
    }

    fileMatchesAccept(file, accept) {
        if (!accept) return true;

        return accept
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .some((entry) => {
                if (entry.endsWith('/*')) {
                    return file.type.startsWith(entry.slice(0, -1));
                }

                return file.type === entry || file.name.toLowerCase().endsWith(entry.toLowerCase());
            });
    }
    // -------------------------------------------------------------------------
    // Generic GUI value editors
    // -------------------------------------------------------------------------
    addTags(folder, object, label = 'Tags') {
        const state = {
            tags: object.tags?.join(', ') ?? '',
        };

        folder
            .add(state, 'tags')
            .name(label)
            .onFinishChange((value) => {
                const tags = String(value)
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean);

                object.tags = tags.length > 0 ? tags : undefined;
                this.host.emitCode();
            });
    }

    addObject(
        folder,
        object,
        hidden = new Set(),
        seen = new WeakSet(),
    ) {
        if (
            !object
            || typeof object !== 'object'
            || seen.has(object)
        ) {
            return;
        }

        seen.add(object);

        Object.keys(object)
            .filter(
                (key) =>
                    !key.startsWith('_')
                    && !hidden.has(key)
            )
            .forEach(
                (key) =>
                    this.addValue(
                        folder,
                        object,
                        key,
                        this.host.prettyName(key),
                        seen,
                    )
            );
    }

    addValue(
        folder,
        object,
        key,
        label,
        seen = new WeakSet(),
    ) {
        const value = object[key];
        if (typeof value === 'function') {
            const state = { value: 'ƒ(t) — function driven' };
            folder.add(state, 'value').name(label).disable();
            return;
        }
        if (value instanceof THREE.Vector3) {
            const vectorFolder = folder.addFolder(label);
            vectorFolder.close();
            this.addVector3(vectorFolder, value, label);
            return;
        }
        if (value instanceof THREE.Vector2) {
            const vectorFolder = folder.addFolder(label);
            vectorFolder.close();
            this.addVector2(vectorFolder, value, label);
            return;
        }
        if (value instanceof THREE.Color) {
            const state = { color: `#${value.getHexString()}` };
            folder.addColor(state, 'color').name(label).onChange((hex) => value.set(hex));
            return;
        }
        if (Array.isArray(value)) {
            const arrayFolder = folder.addFolder(label);
            arrayFolder.close();

            value.forEach(
                (_, index) =>
                    this.addValue(
                        arrayFolder,
                        value,
                        String(index),
                        index === 0
                            ? 'Min / 0'
                            : 'Max / 1',
                        seen,
                    )
            );

            return;
        }
        if (value instanceof Set) {
            const setFolder = folder.addFolder(label);
            setFolder.close();
            this.addSetValue(setFolder, value);
            return;
        }
        if (value && typeof value === 'object') {
            if (seen.has(value)) {
                return;
            }

            const objectFolder = folder.addFolder(label);
            objectFolder.close();
            this.addObject(
                objectFolder,
                value,
                new Set(),
                seen,
            );

            return;
        }
        if (typeof value === 'number') {
            folder.add(object, key).name(label);
        }
        else if (typeof value === 'boolean' || typeof value === 'string') {
            folder.add(object, key).name(label);
        }
        else if (value === undefined || value === null) {
            const state = { value: String(value) };
            folder.add(state, 'value').name(label).disable();
        }
    }

    addDynamicValue(folder, object, key, label) {
        const value = object[key];
        if (typeof value === 'function') {
            const state = { mode: 'Function', value: 'ƒ(t)' };
            folder.add(state, 'mode').name(`${label} Mode`).disable();
            folder.add(state, 'value').name(label).disable();
            return;
        }
        if (Array.isArray(value) && value.length === 2) {
            const sub = folder.addFolder(label);
            sub.close();
            const state = { mode: 'Random Between' };
            sub.add(state, 'mode').name('Mode').disable();
            this.addValue(sub, value, '0', 'Min');
            this.addValue(sub, value, '1', 'Max');
            return;
        }
        if (value instanceof Set) {
            const sub = folder.addFolder(label);
            sub.close();
            const state = { mode: 'Random Set' };
            sub.add(state, 'mode').name('Mode').disable();
            this.addSetValue(sub, value);
            return;
        }
        this.addValue(folder, object, key, label);
    }

    addSetValue(folder, set) {
        Array.from(set).forEach((item, index) => {
            const label = `Option ${index + 1}`;

            if (item instanceof THREE.Color) {
                const state = { color: `#${item.getHexString()}` };
                folder.addColor(state, 'color').name(label).onChange((hex) => {
                    item.set(hex);
                });
                return;
            }

            if (item instanceof THREE.Vector3) {
                const vectorFolder = folder.addFolder(label);
                vectorFolder.close();
                this.addVector3(vectorFolder, item, label);
                return;
            }

            if (item instanceof THREE.Vector2) {
                const vectorFolder = folder.addFolder(label);
                vectorFolder.close();
                this.addVector2(vectorFolder, item, label);
                return;
            }

            if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') {
                const state = { value: item };
                folder.add(state, 'value').name(label).onChange((nextValue) => {
                    const values = Array.from(set);
                    values[index] = nextValue;
                    set.clear();
                    values.forEach((value) => set.add(value));
                });
                return;
            }

            this.addValue(
                folder,
                Array.from(set),
                String(index),
                label,
            );
        });
    }

    addVector3(folder, vector, label) {
        folder.add(vector, 'x').name(`${label} X`);
        folder.add(vector, 'y').name(`${label} Y`);
        folder.add(vector, 'z').name(`${label} Z`);
    }

    addVector2(folder, vector, label, onFinishChange) {
        const x = folder.add(vector, 'x').name(`${label} X`);
        const y = folder.add(vector, 'y').name(`${label} Y`);
        if (onFinishChange) {
            x.onFinishChange(onFinishChange);
            y.onFinishChange(onFinishChange);
        }
    }


    audioBufferSource(buffer) {
        return buffer?.[AUDIO_BUFFER_SOURCE_KEY]?.url;
    }

    audioBufferLabel(buffer) {
        const source = buffer?.[AUDIO_BUFFER_SOURCE_KEY];
        return source?.name || source?.url || `${buffer?.duration?.toFixed?.(2) ?? '?'}s clip`;
    }

    setAudioBufferSource(buffer, url, name = url) {
        if (!buffer) return buffer;
        Object.defineProperty(buffer, AUDIO_BUFFER_SOURCE_KEY, {
            value: { url, name },
            configurable: true,
        });
        return buffer;
    }
}

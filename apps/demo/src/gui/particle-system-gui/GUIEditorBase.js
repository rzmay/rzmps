export class GUIEditorBase {
    constructor(host) {
        this.host = host;
    }

    get system() { return this.host.system; }
    get moduleFactories() { return this.host.moduleFactories; }
    get rendererFactories() { return this.host.rendererFactories; }

    rebuild() { return this.host.rebuild(); }
    emitCode() { return this.host.emitCode(); }
    prettyName(value) { return this.host.prettyName(value); }

    addTags(...args) { return this.host.valueEditor.addTags(...args); }
    addObject(...args) { return this.host.valueEditor.addObject(...args); }
    addValue(...args) { return this.host.valueEditor.addValue(...args); }
    addDynamicValue(...args) { return this.host.valueEditor.addDynamicValue(...args); }
    addSetValue(...args) { return this.host.valueEditor.addSetValue(...args); }
    addVector3(...args) { return this.host.valueEditor.addVector3(...args); }
    addVector2(...args) { return this.host.valueEditor.addVector2(...args); }
    addTextureUpload(...args) { return this.host.valueEditor.addTextureUpload(...args); }
    addAudioUpload(...args) { return this.host.valueEditor.addAudioUpload(...args); }

    buildUpdateLOD(...args) { return this.host.emitterGUI.buildUpdateLOD(...args); }
    buildCountLOD(...args) { return this.host.emitterGUI.buildCountLOD(...args); }
}

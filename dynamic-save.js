// dynamic-save.js
// In-memory save/settings store shared across the client. Exposes `save`,
// which holds `save.public` (the live, readable mirror of state other files
// read from every frame) and `save.data` (the write API used to mutate
// state, split into a public side that's mirrored to save.public and a
// private side that is not exposed and is explicitly NOT secure in this
// version).

// save — the shared save-state object. `public` is the live mirror other
// files read from; `data` is populated below with the write/read API.
const save = {
    data: null,
    public: {}
};

// save.data — write/read API for the save store, built as an IIFE closing
// over private `data` and `privateData` objects so callers can only reach
// them through the returned functions.
save.data = (function () {
    // data — the private backing store for public keys, mirrored into
    // save.public by writePublic/updatePublic.
    let data = {};

    // privateData — the private backing store for private keys; never
    // mirrored to save.public and only reachable via writePrivate/readPrivate.
    let privateData = {};

    // writePublic — sets `data[key]` to `value`, optionally mirroring it into
    // save.public immediately (default true), and logs who made the write.
    function writePublic(key, value, writer, update = true) {
        data[key] = value;
        if (update) save.public[key] = data[key];
        console.log(`${JSON.stringify(writer)} set "${JSON.stringify(key)}" to "${JSON.stringify(value)}"`);
    };

    // updatePublic — mirrors `data` into save.public. With no keys given,
    // replaces save.public entirely with a deep clone of `data`; with
    // specific_keys given, deep-clones only those keys over.
    function updatePublic(specific_keys = []) {
        if (specific_keys.length === 0) {
            save.public = structuredClone(data);
            return;
        }

        specific_keys.forEach(key => {
            if (key in data) save.public[key] = structuredClone(data[key]);
        });
    };

    // writePrivate — sets `privateData[key]` to `value` and logs who made
    // the write, along with a reminder that private data isn't actually
    // secure in this version.
    function writePrivate(key, value, writer) {
        privateData[key] = value;
        console.log('WARNING | private data is NOT secure in this version | WARNING');
        console.log(`${JSON.stringify(writer)} set private key: ${JSON.stringify(key)}`);
    }

    // readPrivate — returns a deep clone of `privateData[key]` wrapped as
    // { err: null, data }, or { err: 'Key Not Found', data: null } if the key
    // doesn't exist. Logs the access either way.
    function readPrivate(key, reader) {
        if (!(key in privateData)) {
            console.log(`${JSON.stringify(reader)} attempted access to non-existent private key: ${JSON.stringify(key)}`);
            return {err: 'Key Not Found', data: null};
        }
        console.log(`${reader} accessed private key: ${JSON.stringify(key)}`);
        return {err: null, data: structuredClone(privateData[key])}
    }

    return { writePublic, updatePublic, writePrivate, readPrivate};
})();
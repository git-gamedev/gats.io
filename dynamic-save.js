const save = {
    data: null,
    public: {}
};

save.data = (function () {
    let data = {};
    let privateData = {};

    function writePublic(key, value, writer, update = true) {
        data[key] = value;
        if (update) save.public[key] = data[key];
        console.log(`${JSON.stringify(writer)} set "${JSON.stringify(key)}" to "${JSON.stringify(value)}"`);
    };

    function updatePublic(specific_keys = []) {
        if (specific_keys.length === 0) {
            save.public = structuredClone(data);
            return;
        }

        specific_keys.forEach(key => {
            if (key in data) save.public[key] = structuredClone(data[key]);
        });
    };


    function writePrivate(key, value, writer) {
        privateData[key] = value;
        console.log('WARNING | private data is NOT secure in this version | WARNING');
        console.log(`${JSON.stringify(writer)} set private key: ${JSON.stringify(key)}`);
    }

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
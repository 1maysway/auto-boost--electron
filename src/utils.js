// const remote = window.require('electron').remote;
// const electronFs = remote.require('fs');
// const electronDialog = remote.dialog;

const fs = require('fs');
const path = require('path');
const axios = require("axios");
const { requireTaskPool } = require('electron-remote');
const ipcRenderer = requireTaskPool(require('electron').ipcRenderer);

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function getFolderContents(folderPath) {
    // folderPath = path.join(app.getPath('userData'), folderPath);
    const absolutePath = path.resolve(folderPath);
    const contents = [];

    try {
        const files = fs.readdirSync(folderPath);

        files.forEach(file => {
            try {
                const filePath = path.join(folderPath, file);
                const stats = fs.statSync(filePath);

                if (stats.isFile()) {
                    contents.push({
                        name: file,
                        type: 'file'
                    });
                } else if (stats.isDirectory()) {
                    contents.push({
                        name: file,
                        type: 'directory'
                    });
                }
            } catch (error) {
                console.error(error);
            }
        });
    } catch (error) {
        console.error('Error reading folder contents:', error);
        return null;
    }

    return contents;
}

function setPropertyByPath(path, obj, value) {
    let target = obj;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (target.hasOwnProperty(key)) {
            target = target[key];
        } else {
            return; // Если свойство не найдено, выходим из функции без изменений
        }
    }

    const lastKey = path[path.length - 1];
    target[lastKey] = value;
}

function deleteFolder(folderPath) {
    // folderPath = path.join(app.getPath('userData'), folderPath);
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach((file) => {
            const curPath = `${folderPath}/${file}`;
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteFolder(curPath); // Рекурсивно вызываем функцию для удаления вложенных папок
            } else {
                fs.unlinkSync(curPath); // Удаляем файл
            }
        });
        fs.rmdirSync(folderPath); // Удаляем пустую папку
    } else {}
}

function createFolder(folderPath) {
    // folderPath = path.join(app.getPath('userData'), folderPath);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
    }
}

function writeFile(filePath, content) {
    // filePath = path.join(app.getPath('userData'), filePath);
    fs.writeFileSync(filePath, content);
}

function readFile(filePath) {
    // filePath = path.join(app.getPath('userData'), filePath);
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content;
    } catch (error) {
        console.error(`Ошибка при чтении файла: ${error}`);
        return null;
    }
}

function padZero(num) {
    return num < 10 ? `0${num}` : num;
}

function getTimeZone() {

    const currentDate = new Date();
    const timezoneOffsetMinutes = currentDate.getTimezoneOffset();

    const timezoneOffsetHours = Math.floor(Math.abs(timezoneOffsetMinutes) / 60);
    const timezoneOffsetMinutesRemainder = Math.abs(timezoneOffsetMinutes) % 60;

    const sign = timezoneOffsetMinutes > 0 ? '-' : '+';

    const timezoneOffsetFormatted = `${sign}${padZero(timezoneOffsetHours)}:${padZero(timezoneOffsetMinutesRemainder)}`;

    return timezoneOffsetFormatted;
}

const axiosClient = axios.create({
    baseURL: 'http://localhost:80/',
    headers: {
        'x-access-token': "",
    },
});

const shuffleArray = (array) => {
    return array.sort(() => Math.random() - 0.5);
}

function checkProxyType(proxy) {
    const pattern = /^[a-zA-Z0-9]+:[a-zA-Z0-9]+@[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$/;
    return pattern.test(proxy);
}

module.exports = {
    generateId,
    getFolderContents,
    setPropertyByPath,
    deleteFolder,
    createFolder,
    writeFile,
    readFile,
    getTimeZone,
    axiosClient,
    shuffleArray,
    checkProxyType,
    padZero,
};
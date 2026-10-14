# Независимый Python backend

Этап 1: граница приёма и проверки статистики без HTTP, хранения и развёртывания.
Принимает один JSON из stdin, выводит только `{"accepted": true|false}`;
код выхода 0 при корректном отчёте, 1 при некорректном. Не выводит входные данные,
пути, диагностические значения валидатора или IP-адреса.

Установка из корня репозитория:

```sh
python -m pip install -r backend/requirements.txt
```

Запуск в каталоге `backend`:

```sh
python -m duprove_backend < ../contracts/fixtures/example.json
```

PowerShell, из корня:

```powershell
Get-Content contracts/fixtures/example.json -Raw | .venv/Scripts/python.exe -m backend.duprove_backend
```

Для отдельного размещения нужны только `backend/` и `contracts/report.schema.json`
с сохранением взаимного расположения. C++, Electron и Node не нужны.
В этапе 7 сюда добавляются endpoint, HTTPS, лимиты и хранение;
в этапе 8 — клиентский транспорт. Сервис пока не развёрнут.

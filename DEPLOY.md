# Деплой на Ubuntu 24.04 (без домена)

Инструкция для развёртывания Symfony 8.0 приложения на чистом сервере Ubuntu 24.04 с доступом по IP.

---

## Шаг 1 — Установка пакетов на сервере

```bash
sudo apt update && sudo apt upgrade -y

# PHP 8.4 (в Ubuntu 24.04 по умолчанию может быть 8.3, нужен 8.4)
sudo add-apt-repository ppa:ondrej/php -y
sudo apt update

sudo apt install -y \
    php8.4 \
    php8.4-fpm \
    php8.4-cli \
    php8.4-ctype \
    php8.4-iconv \
    php8.4-mbstring \
    php8.4-xml \
    php8.4-curl \
    php8.4-intl \
    php8.4-zip \
    nginx \
    git \
    unzip
```

### Composer

```bash
curl -sS https://getcomposer.org/installer | php
sudo mv composer.phar /usr/local/bin/composer
composer --version
```

---

## Шаг 2 — Клонирование и установка зависимостей

```bash
sudo mkdir -p /var/www/optimal-route
sudo chown $USER:www-data /var/www/optimal-route
cd /var/www/optimal-route

git clone git@github.com:baldrys-ed/optimal-route.git .

APP_ENV=prod composer install --no-dev --optimize-autoloader
```

---

## Шаг 3 — Переменные окружения

Создать файл `.env.local` с реальными ключами (не попадает в git):

```bash
nano /var/www/optimal-route/.env.local
```

Содержимое:

```dotenv
APP_ENV=prod
APP_SECRET=           # сгенерировать: openssl rand -hex 16

TWOGIS_API_KEY=       # вставить ключ
OPENAI_API_KEY=       # вставить ключ
```

Скомпилировать `.env` для production:

```bash
composer dump-env prod
```

---

## Шаг 4 — Права доступа

```bash
sudo chown -R $USER:www-data /var/www/optimal-route
sudo chmod -R 770 /var/www/optimal-route/var
```

---

## Шаг 5 — Nginx

Создать конфиг:

```bash
sudo nano /etc/nginx/sites-available/optimal-route
```

Содержимое:

```nginx
server {
    listen 80;
    server_name _;

    root /var/www/optimal-route/public;
    index index.php;

    location / {
        try_files $uri /index.php$is_args$args;
    }

    location ~ ^/index\.php(/|$) {
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        fastcgi_split_path_info ^(.+\.php)(/.*)$;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT $realpath_root;
        internal;
    }

    location ~ \.php$ {
        return 404;
    }

    error_log /var/log/nginx/optimal-route_error.log;
    access_log /var/log/nginx/optimal-route_access.log;
}
```

Включить и перезапустить:

```bash
sudo ln -s /etc/nginx/sites-available/optimal-route /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable nginx
sudo systemctl enable php8.4-fpm
```

---

## Шаг 6 — Прогрев кэша

```bash
cd /var/www/optimal-route
APP_ENV=prod php bin/console cache:clear
APP_ENV=prod php bin/console cache:warmup
```

Открыть в браузере: `http://<IP_сервера>`

---

## Обновление приложения

```bash
cd /var/www/optimal-route
git pull origin main
APP_ENV=prod composer install --no-dev --optimize-autoloader
composer dump-env prod
APP_ENV=prod php bin/console cache:clear
```

---

## Логи для отладки

```bash
tail -f /var/log/nginx/optimal-route_error.log
tail -f /var/www/optimal-route/var/log/prod.log
```

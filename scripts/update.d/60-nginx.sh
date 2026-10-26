# Paso: Nginx. NUNCA se sobrescribe el vhost del panel si existe (el operador o
# Certbot lo personalizan: SSL, WebSocket…). Solo se instala si falta, y se añade
# el límite de subida global si no está.
STEP_DESC="Nginx (vhost del panel y límite de subida)"
LIVE_NGINX=/etc/nginx/sites-available/txpl-panel
UPLOAD_CONF=/etc/nginx/conf.d/txpl-upload.conf
step_check() { [[ ! -f "$LIVE_NGINX" || ! -f "$UPLOAD_CONF" ]]; }
step_run() {
    local made_vhost=0 made_upload=0
    if [[ ! -f "$LIVE_NGINX" && -f "$SRC/txpl-nginx.conf" ]]; then
        made_vhost=1
        cp "$SRC/txpl-nginx.conf" "$LIVE_NGINX"
        ln -sf "$LIVE_NGINX" /etc/nginx/sites-enabled/txpl-panel
    fi
    if [[ ! -f "$UPLOAD_CONF" ]]; then made_upload=1; echo 'client_max_body_size 512M;' > "$UPLOAD_CONF"; fi
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
    else
        # Deshacemos solo lo que ha creado este paso, para no dejar Nginx roto.
        [[ $made_upload == 1 ]] && rm -f "$UPLOAD_CONF"
        [[ $made_vhost == 1 ]] && rm -f "$LIVE_NGINX" /etc/nginx/sites-enabled/txpl-panel
        warn "Config Nginx inválida; revisa con: nginx -t"
    fi
}

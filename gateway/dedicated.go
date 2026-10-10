// Optional always-on game server: runs the stock UrT dedicated binary as a child
// process (restarting it if it dies), so one container serves the site and a game.
package main

import (
	"bufio"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type dedicatedConfig struct {
	bin      string // Quake3-UrT-Ded.x86_64
	basePath string // has q3ut4/*.pk3 (the web packs work: the server ignores textures)
	homePath string // writable; q3ut4/server.cfg and q3ut4/mapcycle.txt live here
	port     string
}

func runDedicated(ctx context.Context, c dedicatedConfig) {
	for ctx.Err() == nil {
		firstMap := "ut4_turnpike"
		if b, err := os.ReadFile(filepath.Join(c.homePath, "q3ut4", "mapcycle.txt")); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if line = strings.TrimSpace(line); line != "" {
					firstMap = line
					break
				}
			}
		}
		cmd := exec.CommandContext(ctx, c.bin,
			"+set", "fs_basepath", c.basePath, "+set", "fs_homepath", c.homePath, "+set", "fs_game", "q3ut4",
			"+set", "dedicated", "1", "+set", "net_port", c.port, "+set", "com_hunkmegs", "256",
			"+exec", "server.cfg", "+map", firstMap)
		cmd.Env = append(os.Environ(), "HOME="+c.homePath) // the binary creates ~/.q3a regardless
		cmd.Stdin = nil
		out, _ := cmd.StdoutPipe()
		cmd.Stderr = cmd.Stdout
		log.Printf("starting dedicated server on udp :%s, map %s", c.port, firstMap)
		if err := cmd.Start(); err != nil {
			log.Printf("dedicated server: %v", err)
		} else {
			sc := bufio.NewScanner(out)
			for sc.Scan() {
				if line := strings.TrimRight(sc.Text(), "\r"); line != "" {
					log.Printf("[server] %s", line)
				}
			}
			log.Printf("dedicated server exited: %v", cmd.Wait())
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

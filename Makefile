# KVStore build system.  Targets: make | make run | make test | make clean | make tsan
CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -pthread
BUILD    := build
SRV_SRC  := $(wildcard server/src/*.cpp)
HDRS     := $(wildcard server/src/*.hpp) client/client_lib.hpp

all: $(BUILD)/kvserver $(BUILD)/kvcli $(BUILD)/kvbench

$(BUILD)/kvserver: $(SRV_SRC) $(HDRS)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -o $@ $(SRV_SRC)

$(BUILD)/kvcli: client/kvcli.cpp $(HDRS)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -o $@ client/kvcli.cpp

$(BUILD)/kvbench: client/kvbench.cpp $(HDRS)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -o $@ client/kvbench.cpp

run: all
	./$(BUILD)/kvserver --port 7070

test: all
	python3 tests/run_tests.py

# Data-race detection build (ThreadSanitizer), as listed in the project synopsis.
tsan:
	@mkdir -p $(BUILD)
	$(CXX) -std=c++17 -O1 -g -fsanitize=thread -pthread -o $(BUILD)/kvserver_tsan $(SRV_SRC)

clean:
	rm -rf $(BUILD)

.PHONY: all run test tsan clean
